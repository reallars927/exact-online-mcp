import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ExactClient } from "./exact-client.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

export function registerTools(server: McpServer, client: ExactClient): void {
  server.tool(
    "list_sales_invoices",
    "List posted sales invoices (verkoopfacturen) from Exact Online, sourced from the sales ledger " +
      "(salesentry/SalesEntries). Returns a plain array with fields: EntryNumber (the invoice number), " +
      "EntryDate, CustomerName, AmountDC, Currency, StatusDescription, DueDate. " +
      "Filter/orderby must use these field names (or others on the SalesEntry entity, e.g. Status, " +
      "InvoiceNumber, Journal) — note the date field is `EntryDate`, not `InvoiceDate`.",
    {
      top: z.number().int().min(1).max(1000).optional().describe("Max results (default: 100)"),
      filter: z.string().optional().describe("OData $filter, e.g. \"Status eq 50\" (20=open, 50=processed)"),
      orderby: z.string().optional().describe("OData $orderby, e.g. \"EntryDate desc\" (default). Field is EntryDate, not InvoiceDate."),
    },
    async (args) => {
      try { return ok(await client.getSalesInvoices(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "list_purchase_invoices",
    "List purchase invoices (crediteuren) from Exact Online, sourced from the purchase ledger " +
      "(purchaseentry/PurchaseEntries). Returns a plain array with fields: EntryNumber, EntryDate, " +
      "SupplierName, AmountDC, Currency, StatusDescription, DueDate. Amounts are signed — credit notes " +
      "come through negative. Filter/orderby field names match those returned fields (date field is EntryDate).",
    {
      top: z.number().int().min(1).max(1000).optional().describe("Max results (default: 100)"),
      filter: z.string().optional().describe("OData $filter expression, e.g. \"Status eq 50\""),
      orderby: z.string().optional().describe("OData $orderby expression, e.g. \"EntryDate desc\" (default)"),
    },
    async (args) => {
      try { return ok(await client.getPurchaseInvoices(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "list_gl_transactions",
    "List general ledger transaction lines (boekingen) from the bulk sync endpoint " +
      "(bulk/Financial/TransactionLines). Returns a plain array with fields: GLAccountCode, " +
      "GLAccountDescription, AmountDC, Date, Description, JournalDescription. Rows are individual " +
      "journal lines, not aggregated per account — use get_trial_balance for per-account totals.",
    {
      top: z.number().int().min(1).max(1000).optional().describe("Max results (default: 100)"),
      financialYear: z.number().int().optional().describe("Financial year, e.g. 2024"),
      period: z.number().int().min(1).max(12).optional().describe("Financial period (month 1-12)"),
      filter: z.string().optional().describe("Additional OData $filter expression, ANDed with financialYear/period"),
    },
    async (args) => {
      try { return ok(await client.getGLTransactions(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "list_gl_accounts",
    "List general ledger accounts (grootboekrekeningen) from financial/GLAccounts. Returns a plain array " +
      "with fields: Code, Description, TypeDescription, BalanceSide (D/C), IsBlocked. Note: TypeDescription " +
      "is not always reliable for cost/revenue classification — e.g. some fee-clawback accounts (like " +
      "payment-processor fees netted against revenue) are typed as Revenue despite being cost-like.",
    {
      filter: z.string().optional().describe("OData $filter, e.g. \"TypeDescription eq 'Revenue'\""),
    },
    async (args) => {
      try { return ok(await client.getGLAccounts(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "get_receivables",
    "Get outstanding receivables (openstaande debiteuren) — open sales invoices not yet paid, from " +
      "read/financial/ReceivablesList. Returns a plain array with fields: AccountCode, AccountName, " +
      "InvoiceNumber, EntryNumber, InvoiceDate, DueDate, Amount, AmountInTransit, CurrencyCode, " +
      "Description, YourRef. Does not compute aging buckets — use DueDate against today's date for that.",
    {
      top: z.number().int().min(1).max(500).optional().describe("Max results (default: 100)"),
    },
    async (args) => {
      try { return ok(await client.getReceivables(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "get_payables",
    "Get outstanding payables (openstaande crediteuren) — open purchase invoices not yet paid, from " +
      "read/financial/PayablesList. Returns a plain array with fields: AccountCode, AccountName, " +
      "InvoiceNumber, EntryNumber, InvoiceDate, DueDate, Amount, AmountInTransit, CurrencyCode, YourRef, " +
      "ApprovalStatus. Amounts are signed — credit notes come through negative. Does not compute aging " +
      "buckets — use DueDate against today's date for that.",
    {
      top: z.number().int().min(1).max(500).optional().describe("Max results (default: 100)"),
    },
    async (args) => {
      try { return ok(await client.getPayables(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "get_trial_balance",
    "Get trial balance (proefbalans) — debit/credit totals per GL account, aggregated across all matching lines. " +
      "Without `period`, returns full-year totals per account. With `period` only, returns that single period's " +
      "movement per account. With `period` and `cumulative: true`, sums periods 1..period for year-to-date " +
      "movement per account. Returns a plain array with fields: GLAccountCode, GLAccountDescription, " +
      "BalanceType (W=P&L, B=Balance sheet), AmountDebit, AmountCredit, Amount. Note: Exact's API exposes no " +
      "opening-balance/carry-forward concept, so balance-sheet accounts here reflect movement within the " +
      "requested range, not a true running balance.",
    {
      financialYear: z.number().int().optional().describe("Financial year, e.g. 2024"),
      period: z.number().int().min(1).max(12).optional().describe("Financial period (month 1-12)"),
      cumulative: z.boolean().optional().describe("When true (with period set), sum periods 1..period for year-to-date totals instead of just that period's movement"),
    },
    async (args) => {
      try { return ok(await client.getTrialBalance(args)); }
      catch (e) { return err(e); }
    },
  );
}
