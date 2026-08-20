import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ExactClient } from "./exact-client.js";

// Allowlist for query_exact: entity path → terse field cheatsheet. The zod enum built from
// the keys is what enforces read-only access — only these GET paths are reachable. Keep the
// cheatsheet terse: it ships in the tool description and costs context in every conversation.
const QUERY_ENTITIES = {
  "system/Divisions": "administrations (divisions) reachable with this login: Code (the number to pass as `division`),HID,Description,City,Country,Currency",
  "financial/GLAccounts": "chart of accounts: ID,Code,Description,TypeDescription,BalanceSide(D/C),IsBlocked",
  "financial/Journals": "journals (needed before booking entries): Code,Description,Type (90=general,22=purchase,20=sales,12=bank,10=cash)",
  "vat/VATCodes": "VAT codes (needed for VAT on entries): Code,Description,Percentage (fraction, e.g. 0.21),Type",
  "crm/Accounts": "customers/suppliers master data: ID,Code,Name,Status(C=customer,A=none),IsSupplier,City,Country,VATNumber,Email,Phone. Code is an 18-char space-padded string — filter with leading spaces or use Name",
  "financial/FinancialPeriods": "period calendar: FinYear,FinPeriod,StartDate,EndDate",
  "salesentry/SalesEntries": "posted sales ledger entries: EntryNumber,EntryDate,CustomerName,AmountDC,Currency,Status,StatusDescription,DueDate,YourRef",
  "purchaseentry/PurchaseEntries": "posted purchase ledger entries: EntryNumber,EntryDate,SupplierName,AmountDC,Currency,Status,StatusDescription,DueDate,YourRef",
  "generaljournalentry/GeneralJournalEntries": "general journal (memoriaal) entries incl. drafts: EntryNumber,JournalCode,FinancialYear,FinancialPeriod,Status,StatusDescription",
  "read/financial/ReceivablesList": "open sales invoices: AccountCode,AccountName,InvoiceNumber,EntryNumber,InvoiceDate,DueDate,Amount,CurrencyCode,YourRef",
  "read/financial/PayablesList": "open purchase invoices (signed, credit notes negative): AccountCode,AccountName,InvoiceNumber,EntryNumber,InvoiceDate,DueDate,Amount,CurrencyCode,YourRef",
  "read/financial/AgingReceivablesList": "receivables aging buckets per customer: AccountCode,AccountName,AgeGroup1..4 Amount/Description,TotalAmount,CurrencyCode",
  "read/financial/AgingPayablesList": "payables aging buckets per supplier: AccountCode,AccountName,AgeGroup1..4 Amount/Description,TotalAmount,CurrencyCode",
  "bulk/Financial/TransactionLines": "raw GL journal lines: GLAccountCode,GLAccountDescription,AmountDC,Date,Description,JournalCode,FinancialYear,FinancialPeriod",
  "financialtransaction/BankEntries": "bank statement entries (headers; the individual lines are in bulk/Financial/TransactionLines under the bank journal): EntryNumber,JournalCode,JournalDescription,FinancialYear,FinancialPeriod,OpeningBalanceFC,ClosingBalanceFC,Status,StatusDescription",
} as const;

type QueryEntity = keyof typeof QUERY_ENTITIES;
const QUERY_ENTITY_KEYS = Object.keys(QUERY_ENTITIES) as [QueryEntity, ...QueryEntity[]];
const QUERY_CHEATSHEET = Object.entries(QUERY_ENTITIES)
  .map(([path, fields]) => `- ${path} — ${fields}`)
  .join("\n");

// Every tool targets the connected account's current division by default; this shared
// optional parameter lets multi-administration companies point a call at another one.
const DIVISION = z.number().int().optional().describe(
  "Division (administration) code to target instead of the default current division. Discover codes via query_exact on system/Divisions.",
);

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
      division: DIVISION,
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
      division: DIVISION,
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
      division: DIVISION,
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
      division: DIVISION,
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
      "Description, YourRef. For aging buckets, use query_exact on read/financial/AgingReceivablesList.",
    {
      top: z.number().int().min(1).max(500).optional().describe("Max results (default: 100)"),
      division: DIVISION,
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
      "ApprovalStatus. Amounts are signed — credit notes come through negative. For aging buckets, " +
      "use query_exact on read/financial/AgingPayablesList.",
    {
      top: z.number().int().min(1).max(500).optional().describe("Max results (default: 100)"),
      division: DIVISION,
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
      division: DIVISION,
    },
    async (args) => {
      try { return ok(await client.getTrialBalance(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "query_exact",
    "Generic read-only OData query against an allowlisted set of Exact Online entities. Use this for " +
      "anything the dedicated tools don't cover, and for the lookups the draft_* tools need (journal " +
      "codes, VAT codes, GL account codes, supplier codes). Returns a plain array (OData envelope " +
      "unwrapped, auto-paginated). If a field name is rejected, the Exact error names the problem — " +
      "adjust and retry. Available entities:\n" + QUERY_CHEATSHEET,
    {
      entity: z.enum(QUERY_ENTITY_KEYS).describe("Entity path to query"),
      select: z.string().optional().describe("OData $select, comma-separated field names (omit for all fields)"),
      filter: z.string().optional().describe("OData $filter, e.g. \"FinancialYear eq 2026 and Status eq 20\""),
      orderby: z.string().optional().describe("OData $orderby, e.g. \"EntryDate desc\""),
      top: z.number().int().min(1).max(1000).optional().describe("Max results (default: 100)"),
      division: DIVISION,
    },
    async (args) => {
      try { return ok(await client.queryEntity(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "draft_general_journal_entry",
    "Create a general journal entry (memoriaalboeking) as a DRAFT: it lands unprocessed (Status 20) in " +
      "Exact for human review and processing there — it does not hit the books directly (unless the " +
      "journal is configured to process immediately). Look up the journal code first via query_exact on " +
      "financial/Journals (Type 90) and GL account codes via financial/GLAccounts. Line amounts are " +
      "signed (positive=debit, negative=credit) and must balance to zero across the entry. If a vatCode " +
      "is set, Exact auto-generates the VAT lines and the amount is treated as including VAT.",
    {
      journalCode: z.string().describe("Code of a general journal (Type 90), from financial/Journals"),
      date: z.string().optional().describe("Entry date, ISO format e.g. \"2026-08-17\" (default: today)"),
      lines: z.array(z.object({
        glAccountCode: z.string().describe("GL account code, e.g. \"4000\""),
        amount: z.number().describe("Signed amount: positive=debit, negative=credit. All lines must sum to 0."),
        description: z.string().optional(),
        vatCode: z.string().optional().describe("VAT code from vat/VATCodes; Exact auto-creates the VAT lines"),
        accountCode: z.string().optional().describe("Customer/supplier code, for lines on an AR/AP account"),
      })).min(2).describe("Journal lines (at least 2, balancing to zero)"),
      division: DIVISION,
    },
    async (args) => {
      try { return ok(await client.draftGeneralJournalEntry(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "draft_purchase_entry",
    "Book a supplier invoice (inkoopboeking) as a DRAFT purchase entry: it lands unprocessed (Status 20) " +
      "in Exact for human review and processing there (unless the journal is configured to process " +
      "immediately). Look up the purchase journal code via query_exact on financial/Journals (Type 22), " +
      "the supplier via crm/Accounts, GL account codes via financial/GLAccounts, and VAT codes via " +
      "vat/VATCodes. Line amounts are positive for costs (incl. VAT when vatCode is set); for a credit " +
      "note set creditNote true and keep amounts positive.",
    {
      journalCode: z.string().describe("Code of a purchase journal (Type 22), from financial/Journals"),
      supplierCode: z.string().optional().describe("Supplier account code (crm/Accounts). Provide this or supplierName."),
      supplierName: z.string().optional().describe("Exact supplier name (crm/Accounts) — must match exactly one account"),
      entryDate: z.string().optional().describe("Invoice date, ISO format e.g. \"2026-08-17\""),
      dueDate: z.string().optional().describe("Payment due date, ISO format"),
      yourRef: z.string().optional().describe("The supplier's invoice number"),
      description: z.string().optional(),
      creditNote: z.boolean().optional().describe("True for a purchase credit note (Type 31)"),
      lines: z.array(z.object({
        glAccountCode: z.string().describe("Cost GL account code, e.g. \"4500\""),
        amount: z.number().describe("Positive cost amount; includes VAT when vatCode is set"),
        description: z.string().optional(),
        vatCode: z.string().optional().describe("VAT code from vat/VATCodes; VAT is auto-calculated"),
      })).min(1),
      division: DIVISION,
    },
    async (args) => {
      try { return ok(await client.draftPurchaseEntry(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "draft_sales_entry",
    "Book a sales invoice (verkoopboeking) as a DRAFT sales entry: it lands unprocessed (Status 20) in " +
      "Exact for human review and processing there (unless the journal is configured to process " +
      "immediately). Look up the sales journal code via query_exact on financial/Journals (Type 20), " +
      "the customer via crm/Accounts, GL account codes via financial/GLAccounts, and VAT codes via " +
      "vat/VATCodes. Line amounts are positive revenue amounts (incl. VAT when vatCode is set); for a " +
      "credit note set creditNote true and keep amounts positive.",
    {
      journalCode: z.string().describe("Code of a sales journal (Type 20), from financial/Journals"),
      customerCode: z.string().optional().describe("Customer account code (crm/Accounts). Provide this or customerName."),
      customerName: z.string().optional().describe("Exact customer name (crm/Accounts) — must match exactly one account"),
      entryDate: z.string().optional().describe("Invoice date, ISO format e.g. \"2026-08-20\""),
      dueDate: z.string().optional().describe("Payment due date, ISO format"),
      yourRef: z.string().optional().describe("Reference/invoice number visible to the customer"),
      description: z.string().optional(),
      creditNote: z.boolean().optional().describe("True for a sales credit note (Type 21)"),
      lines: z.array(z.object({
        glAccountCode: z.string().describe("Revenue GL account code, e.g. \"8000\""),
        amount: z.number().describe("Positive revenue amount; includes VAT when vatCode is set"),
        description: z.string().optional(),
        vatCode: z.string().optional().describe("VAT code from vat/VATCodes; VAT is auto-calculated"),
      })).min(1),
      division: DIVISION,
    },
    async (args) => {
      try { return ok(await client.draftSalesEntry(args)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "create_or_update_account",
    "Create or update a customer/supplier master-data record (crm/Accounts). UNLIKE the draft_* tools " +
      "this has NO draft state — changes apply to Exact immediately. With `id` (GUID from query_exact on " +
      "crm/Accounts) it updates only the provided fields; without `id` it creates a new account (name " +
      "required, Exact assigns the code).",
    {
      id: z.string().optional().describe("Account GUID to update; omit to create a new account"),
      name: z.string().optional().describe("Account name (required when creating)"),
      isSupplier: z.boolean().optional(),
      isCustomer: z.boolean().optional().describe("True sets customer status (C); false clears it (A)"),
      email: z.string().optional(),
      phone: z.string().optional(),
      addressLine1: z.string().optional(),
      postcode: z.string().optional(),
      city: z.string().optional(),
      country: z.string().optional().describe("ISO country code, e.g. \"NL\""),
      vatNumber: z.string().optional(),
      chamberOfCommerce: z.string().optional().describe("KvK number"),
      division: DIVISION,
    },
    async (args) => {
      try { return ok(await client.createOrUpdateAccount(args)); }
      catch (e) { return err(e); }
    },
  );
}
