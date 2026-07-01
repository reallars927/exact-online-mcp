# exact-online-mcp

A Cloudflare Worker that exposes read-only Exact Online financial data as MCP tools (used as a custom connector, e.g. in claude.ai).

## Architecture

- `src/index.ts` — HTTP routing (`/auth`, `/callback`, `/mcp`), OAuth token exchange, and the `MCP_API_KEY` bearer-auth gate on `/mcp`.
- `src/exact-client.ts` — Exact Online API client: token refresh, pagination, and one method per tool.
- `src/tools.ts` — MCP tool definitions (schema + description) that wrap the client methods.
- Tokens and the cached division ID are stored in the `TOKEN_STORE` KV namespace.

### Auth flow

1. Visit `/auth` → redirects to Exact's OAuth consent screen.
2. Exact redirects back to `/callback?code=...` → the worker exchanges the code for tokens, stores them in KV, and caches the current division.
3. `/mcp` requires `Authorization: Bearer <MCP_API_KEY>` and serves the MCP tools using the stored Exact tokens (auto-refreshed as needed).

### Response shape

All list tools return a **plain JSON array** of row objects — the OData envelope (`d.results`, `__next`, etc.) is unwrapped internally. Every list tool auto-paginates up to 20 pages to satisfy the requested `top`.

## Tools

| Tool | Exact endpoint | Notes |
|---|---|---|
| `list_sales_invoices` | `salesentry/SalesEntries` | Posted sales ledger entries. **Not** `salesinvoice/SalesInvoices` — that entity is the invoice creation/draft workflow and goes empty once invoices are processed/printed. |
| `list_purchase_invoices` | `purchaseentry/PurchaseEntries` | Posted purchase ledger entries. Signed amounts (credit notes negative). |
| `list_gl_transactions` | `bulk/Financial/TransactionLines` | Raw journal lines, not aggregated per account. |
| `list_gl_accounts` | `financial/GLAccounts` | Chart of accounts. |
| `get_receivables` | `read/financial/ReceivablesList` | Open sales invoices. No computed aging buckets — bucket by `DueDate` yourself. |
| `get_payables` | `read/financial/PayablesList` | Open purchase invoices. Signed amounts. No computed aging buckets. |
| `get_trial_balance` | `financial/ReportingBalance` | Aggregated per GL account client-side (see below). |

Full field lists and filter/orderby guidance are in each tool's description in `src/tools.ts` — keep those in sync with `exact-client.ts`'s `$select` clauses when either changes.

### `get_trial_balance` semantics

Exact's API has no opening-balance/carry-forward concept — `ReportingBalance` only ever exposes period movement, never a cumulative balance. `get_trial_balance` works around this:

- No `period` → full financial year, aggregated per account.
- `period` only → that single period's movement, aggregated per account.
- `period` + `cumulative: true` → sums periods `1..period` for year-to-date movement per account.

None of these produce a true balance-sheet total (cash, equity, etc.) — balance-sheet accounts carry forward across fiscal years, and Exact doesn't expose that anywhere in this API. What you get is movement within the requested range, not a running balance.

## Known Exact API quirks (learned the hard way)

- **Two different JSON envelopes.** Classic collections wrap rows as `{ d: { results: [...], __next } }`. Bulk/cursor-style endpoints (confirmed for `/bulk/...`) return `{ d: [...], __next }` — `d` is the array directly, and `__next` is a top-level sibling, not nested. `ExactClient.getAllResults()` handles both; if a new tool starts throwing "unrecognized response shape", this is the first thing to check.
- **`SalesInvoices` vs `SalesEntries`.** `salesinvoice/SalesInvoices` is for the invoice creation/editing workflow — it only holds invoices Exact still considers in-progress, and legitimately empties out once everything's processed. For reporting historical/posted invoices, use `salesentry/SalesEntries` (mirrors `purchaseentry/PurchaseEntries`).
- **Field naming isn't consistent across entities.** `SalesEntries`/`PurchaseEntries` use `EntryDate`; `ReceivablesList`/`PayablesList` use `InvoiceDate`. `SalesInvoices`/`PurchaseEntries` use `Currency`; `ReceivablesList`/`PayablesList` use `CurrencyCode`. Don't assume a field name carries over between entities — check the specific entity's field list.
- **`GLAccounts.TypeDescription` isn't fully reliable.** Some accounts are typed as `Revenue` while functioning as a cost (e.g. a payment-processor fee account netted against revenue). Don't trust `TypeDescription` alone for cost/revenue classification without spot-checking.
- **Refresh tokens rotate.** Every refresh call invalidates the previous refresh token. `ExactClient` single-flights concurrent refreshes in-memory and the Worker reuses one client instance per isolate (see `makeClient` in `index.ts`) so concurrent requests actually share that single-flight instead of racing separate instances.

## Local development

```
npm run dev     # wrangler dev
npx tsc --noEmit  # typecheck
npm run deploy   # wrangler deploy
```

Wrangler requires Node.js v22+.
