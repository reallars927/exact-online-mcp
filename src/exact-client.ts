interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

interface TrialBalanceLine {
  GLAccountCode: string;
  GLAccountDescription: string;
  BalanceType: string;
  AmountDebit: number | string;
  AmountCredit: number | string;
  Amount: number | string;
}

export class ExactClient {
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private kv: KVNamespace,
    private baseUrl: string,
    private clientId: string,
    private clientSecret: string,
    private workerUrl: string,
  ) {}

  private async getAccessToken(): Promise<string> {
    const stored = await this.kv.get<StoredTokens>("tokens", "json");
    if (!stored) {
      throw new Error("Not authenticated. Visit /auth to connect your Exact Online account.");
    }
    if (Date.now() < stored.expires_at - 60_000) {
      return stored.access_token;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken(stored.refresh_token).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) {
      // Exact rotates refresh tokens; a concurrent request in another isolate may have
      // already used this one and stored a fresh pair. Check KV once before giving up.
      const latest = await this.kv.get<StoredTokens>("tokens", "json");
      if (latest && latest.refresh_token !== refreshToken && Date.now() < latest.expires_at - 60_000) {
        return latest.access_token;
      }
      throw new Error(`Token refresh failed: ${await res.text()}`);
    }
    const tokens = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    await this.kv.put("tokens", JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    }));
    return tokens.access_token;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Exact Online API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  /** PUT in Exact's OData API returns 204 No Content on success. */
  private async put(path: string, body: unknown): Promise<void> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Exact Online API error ${res.status}: ${await res.text()}`);
    }
  }

  private escapeODataString(value: string): string {
    return value.replace(/'/g, "''");
  }

  /** Write payloads reference GL accounts by GUID, but tools accept the human-facing
   * account code — this resolves one to the other and fails fast on 0 or >1 matches. */
  private async resolveGLAccountId(code: string, div: number): Promise<string> {
    const rows = await this.getAllResults<{ ID: string; Code: string }>(
      `/api/v1/${div}/financial/GLAccounts`,
      { "$select": "ID,Code", "$filter": `Code eq '${this.escapeODataString(code)}'` },
    );
    if (rows.length !== 1) {
      throw new Error(`GL account code '${code}' matched ${rows.length} accounts; expected exactly 1`);
    }
    return rows[0].ID;
  }

  /** Resolves a crm/Accounts row (customer/supplier) to its GUID by code or exact name.
   * Account codes are stored as fixed-length-18 numeric strings with leading spaces, so
   * code filters must left-pad — passing the bare code matches nothing. */
  private async resolveCrmAccountId(params: { code?: string; name?: string }, div: number): Promise<string> {
    if (!params.code && !params.name) {
      throw new Error("Provide an account code or name to resolve a customer/supplier");
    }
    const filter = params.code
      ? `Code eq '${this.escapeODataString(params.code.padStart(18, " "))}'`
      : `Name eq '${this.escapeODataString(params.name!)}'`;
    const rows = await this.getAllResults<{ ID: string; Code: string; Name: string }>(
      `/api/v1/${div}/crm/Accounts`,
      { "$select": "ID,Code,Name", "$filter": filter },
    );
    if (rows.length !== 1) {
      const matches = rows.map((r) => `${r.Code.trim()} ${r.Name}`).join(", ");
      throw new Error(
        `Account ${params.code ?? params.name} matched ${rows.length} accounts${matches ? ` (${matches})` : ""}; expected exactly 1`,
      );
    }
    return rows[0].ID;
  }

  /** Generic read access for the query_exact tool. The entity allowlist is enforced by the
   * tool's schema enum, not here — this just builds the OData query and paginates. */
  async queryEntity(params: { entity: string; select?: string; filter?: string; orderby?: string; top?: number; division?: number }) {
    const div = params.division ?? await this.getDivision();
    const limit = params.top ?? 100;
    const q: Record<string, string> = { "$top": String(limit) };
    if (params.select) q["$select"] = params.select;
    if (params.filter) q["$filter"] = params.filter;
    if (params.orderby) q["$orderby"] = params.orderby;
    const rows = await this.getAllResults<Record<string, unknown>>(`/api/v1/${div}/${params.entity}`, q, limit);
    // Strip the OData __metadata block from each row — it's per-row URI/type noise that
    // would otherwise dominate the tool output the model has to read.
    return rows.map(({ __metadata, ...rest }) => rest);
  }

  /** Creates a general journal entry (memoriaal). Lines must balance to zero (before any
   * VAT lines Exact auto-generates from vatCode); Exact validates and rejects otherwise.
   * Entries land unprocessed (Status 20) for review in Exact unless the journal is
   * configured to process immediately. */
  async draftGeneralJournalEntry(params: {
    journalCode: string;
    date?: string;
    division?: number;
    lines: { glAccountCode: string; amount: number; description?: string; vatCode?: string; accountCode?: string }[];
  }) {
    const div = params.division ?? await this.getDivision();
    const lines: Record<string, unknown>[] = [];
    for (const line of params.lines) {
      const l: Record<string, unknown> = {
        GLAccount: await this.resolveGLAccountId(line.glAccountCode, div),
        AmountFC: line.amount,
      };
      if (params.date) l.Date = params.date;
      if (line.description) l.Description = line.description;
      if (line.vatCode) l.VATCode = line.vatCode;
      if (line.accountCode) l.Account = await this.resolveCrmAccountId({ code: line.accountCode }, div);
      lines.push(l);
    }
    const created = await this.post<{ d: Record<string, unknown> }>(
      `/api/v1/${div}/generaljournalentry/GeneralJournalEntries`,
      { JournalCode: params.journalCode, GeneralJournalEntryLines: lines },
    );
    const d = created.d;
    return {
      EntryID: d.EntryID,
      EntryNumber: d.EntryNumber,
      JournalCode: d.JournalCode,
      FinancialYear: d.FinancialYear,
      FinancialPeriod: d.FinancialPeriod,
      Status: d.Status,
      StatusDescription: d.StatusDescription,
    };
  }

  /** Creates a purchase entry (inkoopboeking). Line amounts are positive for costs; a
   * credit note uses Type 31 with positive line amounts as well (Exact handles the sign).
   * Entries land unprocessed (Status 20) for review in Exact unless the journal is
   * configured to process immediately. */
  async draftPurchaseEntry(params: {
    journalCode: string;
    supplierCode?: string;
    supplierName?: string;
    entryDate?: string;
    dueDate?: string;
    yourRef?: string;
    description?: string;
    creditNote?: boolean;
    division?: number;
    lines: { glAccountCode: string; amount: number; description?: string; vatCode?: string }[];
  }) {
    const div = params.division ?? await this.getDivision();
    const supplier = await this.resolveCrmAccountId({ code: params.supplierCode, name: params.supplierName }, div);
    const lines: Record<string, unknown>[] = [];
    for (const line of params.lines) {
      const l: Record<string, unknown> = {
        GLAccount: await this.resolveGLAccountId(line.glAccountCode, div),
        AmountFC: line.amount,
      };
      if (line.description) l.Description = line.description;
      if (line.vatCode) l.VATCode = line.vatCode;
      lines.push(l);
    }
    const header: Record<string, unknown> = {
      Journal: params.journalCode,
      Supplier: supplier,
      Type: params.creditNote ? 31 : 30,
      PurchaseEntryLines: lines,
    };
    if (params.entryDate) header.EntryDate = params.entryDate;
    if (params.dueDate) header.DueDate = params.dueDate;
    if (params.yourRef) header.YourRef = params.yourRef;
    if (params.description) header.Description = params.description;
    const created = await this.post<{ d: Record<string, unknown> }>(
      `/api/v1/${div}/purchaseentry/PurchaseEntries`,
      header,
    );
    const d = created.d;
    return {
      EntryID: d.EntryID,
      EntryNumber: d.EntryNumber,
      SupplierName: d.SupplierName,
      EntryDate: d.EntryDate,
      DueDate: d.DueDate,
      AmountFC: d.AmountFC,
      VATAmountFC: d.VATAmountFC,
      Status: d.Status,
      StatusDescription: d.StatusDescription,
    };
  }

  /** Creates a sales entry (verkoopboeking). Line amounts are positive for revenue (incl.
   * VAT when vatCode is set); a credit note uses Type 21 with positive line amounts as
   * well (Exact handles the sign). Entries land unprocessed (Status 20) for review in
   * Exact unless the journal is configured to process immediately. */
  async draftSalesEntry(params: {
    journalCode: string;
    customerCode?: string;
    customerName?: string;
    entryDate?: string;
    dueDate?: string;
    yourRef?: string;
    description?: string;
    creditNote?: boolean;
    division?: number;
    lines: { glAccountCode: string; amount: number; description?: string; vatCode?: string }[];
  }) {
    const div = params.division ?? await this.getDivision();
    const customer = await this.resolveCrmAccountId({ code: params.customerCode, name: params.customerName }, div);
    const lines: Record<string, unknown>[] = [];
    for (const line of params.lines) {
      const l: Record<string, unknown> = {
        GLAccount: await this.resolveGLAccountId(line.glAccountCode, div),
        AmountFC: line.amount,
      };
      if (line.description) l.Description = line.description;
      if (line.vatCode) l.VATCode = line.vatCode;
      lines.push(l);
    }
    const header: Record<string, unknown> = {
      Journal: params.journalCode,
      Customer: customer,
      Type: params.creditNote ? 21 : 20,
      SalesEntryLines: lines,
    };
    if (params.entryDate) header.EntryDate = params.entryDate;
    if (params.dueDate) header.DueDate = params.dueDate;
    if (params.yourRef) header.YourRef = params.yourRef;
    if (params.description) header.Description = params.description;
    const created = await this.post<{ d: Record<string, unknown> }>(
      `/api/v1/${div}/salesentry/SalesEntries`,
      header,
    );
    const d = created.d;
    return {
      EntryID: d.EntryID,
      EntryNumber: d.EntryNumber,
      CustomerName: d.CustomerName,
      EntryDate: d.EntryDate,
      DueDate: d.DueDate,
      AmountFC: d.AmountFC,
      VATAmountFC: d.VATAmountFC,
      Status: d.Status,
      StatusDescription: d.StatusDescription,
    };
  }

  /** Creates (POST) or updates (PUT, when id is given) a customer/supplier master-data
   * record in crm/Accounts. Unlike the entry tools there is no draft state — changes
   * apply immediately. Only provided fields are sent, so updates are partial. */
  async createOrUpdateAccount(params: {
    id?: string;
    name?: string;
    isSupplier?: boolean;
    isCustomer?: boolean;
    email?: string;
    phone?: string;
    addressLine1?: string;
    postcode?: string;
    city?: string;
    country?: string;
    vatNumber?: string;
    chamberOfCommerce?: string;
    division?: number;
  }) {
    const div = params.division ?? await this.getDivision();
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body.Name = params.name;
    if (params.isSupplier !== undefined) body.IsSupplier = params.isSupplier;
    // Status "C" marks the account as a customer; "A" (none) removes that classification.
    if (params.isCustomer !== undefined) body.Status = params.isCustomer ? "C" : "A";
    if (params.email !== undefined) body.Email = params.email;
    if (params.phone !== undefined) body.Phone = params.phone;
    if (params.addressLine1 !== undefined) body.AddressLine1 = params.addressLine1;
    if (params.postcode !== undefined) body.Postcode = params.postcode;
    if (params.city !== undefined) body.City = params.city;
    if (params.country !== undefined) body.Country = params.country;
    if (params.vatNumber !== undefined) body.VATNumber = params.vatNumber;
    if (params.chamberOfCommerce !== undefined) body.ChamberOfCommerce = params.chamberOfCommerce;

    if (params.id) {
      await this.put(`/api/v1/${div}/crm/Accounts(guid'${params.id}')`, body);
      return { updated: params.id };
    }
    if (!params.name) {
      throw new Error("Creating an account requires a name");
    }
    const created = await this.post<{ d: Record<string, unknown> }>(`/api/v1/${div}/crm/Accounts`, body);
    const d = created.d;
    return { ID: d.ID, Code: typeof d.Code === "string" ? d.Code.trim() : d.Code, Name: d.Name };
  }

  /** Keep-alive for the cron trigger: Exact invalidates refresh tokens after ~30 days of
   * disuse, so the scheduled handler calls this to rotate the chain even when no tool
   * requests come in. The access token only lives ~10 minutes, so by the time the cron
   * fires it is always stale and `getAccessToken()` performs a real refresh (rotating the
   * refresh token), rather than a no-op read. Throws if the chain is already dead — the
   * failed cron invocation in the Cloudflare dashboard is the signal to redo `/auth`. */
  async keepTokensFresh(): Promise<void> {
    await this.getAccessToken();
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Exact Online API error ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  /** Fetches all pages up to a page-count guard, optionally stopping once `limit` rows are collected.
   * Exact uses two different envelopes across endpoints: classic collections wrap rows in
   * `d.results` with `d.__next`, while bulk/cursor-style endpoints return `d` as the row array
   * directly with a top-level `__next`. Both are handled here since which one a given endpoint
   * uses isn't consistent (e.g. /bulk/ paths always use the flat form). */
  private async getAllResults<T>(path: string, params: Record<string, string>, limit?: number): Promise<T[]> {
    const token = await this.getAccessToken();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const results: T[] = [];
    let nextUrl: string | undefined = url.toString();
    let pages = 0;
    const maxPages = 20;

    while (nextUrl && pages < maxPages && !(limit !== undefined && results.length >= limit)) {
      const res = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Exact Online API error ${res.status}: ${await res.text()}`);
      }
      const data = await res.json() as { d: T[] | { results: T[]; __next?: string }; __next?: string };
      const pageResults = Array.isArray(data.d) ? data.d : data.d.results;
      const next = Array.isArray(data.d) ? data.__next : data.d.__next;
      if (!Array.isArray(pageResults)) {
        throw new Error(`Exact Online API returned an unrecognized response shape for ${path}`);
      }
      results.push(...pageResults);
      nextUrl = next;
      pages++;
    }

    return limit !== undefined ? results.slice(0, limit) : results;
  }

  async getDivision(): Promise<number> {
    const cached = await this.kv.get<{ id: number }>("division", "json");
    if (cached) return cached.id;
    const data = await this.get<{ d: { results: [{ CurrentDivision: number }] } }>("/api/v1/current/Me");
    const division = data.d.results[0].CurrentDivision;
    await this.kv.put("division", JSON.stringify({ id: division }));
    return division;
  }

  async exchangeCode(code: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: `${this.workerUrl}/callback`,
      }),
    });
    if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
    const tokens = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
    await this.kv.put("tokens", JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    }));
    // Pre-fetch and cache division
    await this.kv.delete("division");
    await this.getDivision();
  }

  async getSalesInvoices(params: { top?: number; filter?: string; orderby?: string; division?: number }) {
    const div = params.division ?? await this.getDivision();
    const limit = params.top ?? 100;
    const q: Record<string, string> = {
      // salesentry/SalesEntries (posted ledger entries) mirrors purchaseentry/PurchaseEntries.
      // salesinvoice/SalesInvoices is the invoice creation/draft-workflow entity and goes empty
      // once invoices are processed/printed, so it's unreliable for reporting historical invoices.
      "$select": "EntryNumber,EntryDate,CustomerName,AmountDC,Currency,StatusDescription,DueDate",
      "$top": String(limit),
      "$orderby": params.orderby ?? "EntryDate desc",
    };
    if (params.filter) q["$filter"] = params.filter;
    return this.getAllResults(`/api/v1/${div}/salesentry/SalesEntries`, q, limit);
  }

  async getPurchaseInvoices(params: { top?: number; filter?: string; orderby?: string; division?: number }) {
    const div = params.division ?? await this.getDivision();
    const limit = params.top ?? 100;
    const q: Record<string, string> = {
      "$select": "EntryNumber,EntryDate,SupplierName,AmountDC,Currency,StatusDescription,DueDate",
      "$top": String(limit),
      "$orderby": params.orderby ?? "EntryDate desc",
    };
    if (params.filter) q["$filter"] = params.filter;
    return this.getAllResults(`/api/v1/${div}/purchaseentry/PurchaseEntries`, q, limit);
  }

  async getGLTransactions(params: { top?: number; filter?: string; financialYear?: number; period?: number; division?: number }) {
    const div = params.division ?? await this.getDivision();
    const limit = params.top ?? 100;
    const q: Record<string, string> = {
      "$select": "GLAccountCode,GLAccountDescription,AmountDC,Date,Description,JournalDescription",
      "$top": String(limit),
      "$orderby": "Date desc",
    };
    const filters: string[] = [];
    if (params.filter) filters.push(params.filter);
    if (params.financialYear) filters.push(`FinancialYear eq ${params.financialYear}`);
    if (params.period) filters.push(`FinancialPeriod eq ${params.period}`);
    if (filters.length) q["$filter"] = filters.join(" and ");
    return this.getAllResults(`/api/v1/${div}/bulk/Financial/TransactionLines`, q, limit);
  }

  async getGLAccounts(params: { filter?: string; division?: number }) {
    const div = params.division ?? await this.getDivision();
    const q: Record<string, string> = {
      "$select": "Code,Description,TypeDescription,BalanceSide,IsBlocked",
      "$orderby": "Code asc",
    };
    if (params.filter) q["$filter"] = params.filter;
    return this.getAllResults(`/api/v1/${div}/financial/GLAccounts`, q);
  }

  async getReceivables(params: { top?: number; division?: number }) {
    const div = params.division ?? await this.getDivision();
    const limit = params.top ?? 100;
    const q: Record<string, string> = {
      "$select": "AccountCode,AccountName,InvoiceNumber,EntryNumber,InvoiceDate,DueDate,Amount,AmountInTransit,CurrencyCode,Description,YourRef",
      "$orderby": "DueDate asc",
      "$top": String(limit),
    };
    return this.getAllResults(`/api/v1/${div}/read/financial/ReceivablesList`, q, limit);
  }

  async getPayables(params: { top?: number; division?: number }) {
    const div = params.division ?? await this.getDivision();
    const limit = params.top ?? 100;
    const q: Record<string, string> = {
      "$select": "AccountCode,AccountName,InvoiceNumber,EntryNumber,InvoiceDate,DueDate,Amount,AmountInTransit,CurrencyCode,YourRef,ApprovalStatus",
      "$orderby": "DueDate asc",
      "$top": String(limit),
    };
    return this.getAllResults(`/api/v1/${div}/read/financial/PayablesList`, q, limit);
  }

  async getTrialBalance(params: { financialYear?: number; period?: number; cumulative?: boolean; division?: number }) {
    const div = params.division ?? await this.getDivision();
    const periods = params.cumulative && params.period
      ? Array.from({ length: params.period }, (_, i) => i + 1)
      : [params.period];

    const rows: TrialBalanceLine[] = [];
    for (const period of periods) {
      const q: Record<string, string> = {
        "$select": "GLAccountCode,GLAccountDescription,BalanceType,AmountDebit,AmountCredit,Amount",
        "$top": "1000",
      };
      const filters: string[] = [];
      if (params.financialYear) filters.push(`ReportingYear eq ${params.financialYear}`);
      if (period) filters.push(`ReportingPeriod eq ${period}`);
      if (filters.length) q["$filter"] = filters.join(" and ");
      rows.push(...await this.getAllResults<TrialBalanceLine>(`/api/v1/${div}/financial/ReportingBalance`, q));
    }

    const byAccount = new Map<string, { GLAccountCode: string; GLAccountDescription: string; BalanceType: string; AmountDebit: number; AmountCredit: number; Amount: number }>();
    for (const row of rows) {
      const debit = Number(row.AmountDebit);
      const credit = Number(row.AmountCredit);
      const amount = Number(row.Amount);
      const existing = byAccount.get(row.GLAccountCode);
      if (existing) {
        existing.AmountDebit += debit;
        existing.AmountCredit += credit;
        existing.Amount += amount;
      } else {
        byAccount.set(row.GLAccountCode, {
          GLAccountCode: row.GLAccountCode,
          GLAccountDescription: row.GLAccountDescription,
          BalanceType: row.BalanceType,
          AmountDebit: debit,
          AmountCredit: credit,
          Amount: amount,
        });
      }
    }
    return [...byAccount.values()];
  }
}
