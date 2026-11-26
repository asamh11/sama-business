// منطق التقارير: دوال نقية بلا اعتماديات، كل المبالغ bigint بالوحدات الصغرى.
// لا تُجمع عملتان معاً أبداً: كل النتائج مفصولة بحسب العملة.

export type ReportAccount = { id: string; code: string; name: string; type: string };
export type ReportLine = {
  account_id: string;
  currency: string;
  debit: number | string | bigint;
  credit: number | string | bigint;
};

export type TrialRow = {
  accountId: string;
  code: string;
  name: string;
  type: string;
  currency: string;
  debit: bigint;
  credit: bigint;
  balance: bigint; // مدين − دائن
};

export type CurrencyTotals = { debit: bigint; credit: bigint; balanced: boolean };

const ZERO = BigInt(0);
const big = (v: number | string | bigint | null | undefined): bigint => BigInt(v ?? 0);

export function trialBalance(accounts: ReportAccount[], lines: ReportLine[]) {
  const byAcc = new Map<string, Map<string, { dr: bigint; cr: bigint }>>();
  for (const l of lines) {
    const m = byAcc.get(l.account_id) ?? new Map<string, { dr: bigint; cr: bigint }>();
    const cur = m.get(l.currency) ?? { dr: ZERO, cr: ZERO };
    cur.dr += big(l.debit);
    cur.cr += big(l.credit);
    m.set(l.currency, cur);
    byAcc.set(l.account_id, m);
  }

  const rows: TrialRow[] = [];
  const totals: Record<string, CurrencyTotals> = {};
  const known = new Set(accounts.map((a) => a.id));

  for (const a of accounts) {
    const m = byAcc.get(a.id);
    if (!m) continue;
    for (const [currency, v] of m) {
      rows.push({
        accountId: a.id, code: a.code, name: a.name, type: a.type, currency,
        debit: v.dr, credit: v.cr, balance: v.dr - v.cr,
      });
    }
  }
  // سطور لحساب غير معروف للواجهة (غير محمّل): لا نُسقطها بصمت، تدخل في المجاميع.
  const orphanAccounts: string[] = [];
  for (const [accId, m] of byAcc) {
    if (known.has(accId)) continue;
    orphanAccounts.push(accId);
  }

  for (const l of lines) {
    const t = totals[l.currency] ?? { debit: ZERO, credit: ZERO, balanced: true };
    t.debit += big(l.debit);
    t.credit += big(l.credit);
    totals[l.currency] = t;
  }
  for (const t of Object.values(totals)) t.balanced = t.debit === t.credit;

  rows.sort((a, b) => (a.currency === b.currency ? a.code.localeCompare(b.code) : a.currency.localeCompare(b.currency)));
  return { rows, totals, orphanAccounts };
}

export type StatementTotals = {
  revenue: bigint;
  expense: bigint;
  netIncome: bigint;
  assets: bigint;
  liabilities: bigint;
  equity: bigint;
  /** الأصول − (الالتزامات + حقوق الملكية + صافي الربح). يجب أن يكون صفراً. */
  imbalance: bigint;
};

/** القوائم المالية لكل عملة من نتيجة trialBalance. */
export function statements(rows: TrialRow[]): Record<string, StatementTotals> {
  const out: Record<string, StatementTotals> = {};
  for (const r of rows) {
    const t = out[r.currency] ?? {
      revenue: ZERO, expense: ZERO, netIncome: ZERO, assets: ZERO,
      liabilities: ZERO, equity: ZERO, imbalance: ZERO,
    };
    switch (r.type) {
      case "revenue":
      case "income":
        t.revenue += r.credit - r.debit;
        break;
      case "expense":
        t.expense += r.debit - r.credit;
        break;
      case "asset":
        t.assets += r.debit - r.credit;
        break;
      case "liability":
        t.liabilities += r.credit - r.debit;
        break;
      case "equity":
        t.equity += r.credit - r.debit;
        break;
    }
    out[r.currency] = t;
  }
  for (const t of Object.values(out)) {
    t.netIncome = t.revenue - t.expense;
    t.imbalance = t.assets - (t.liabilities + t.equity + t.netIncome);
  }
  return out;
}

export type DerivedAlert = {
  id: string;
  level: "high" | "medium" | "info";
  key:
    | "unbalancedCurrency"
    | "unknownAccount"
    | "noBranches"
    | "noAccounts"
    | "noCashboxes"
    | "booksNeverClosed"
    | "dataTruncated";
  params?: Record<string, string>;
};

/** تنبيهات مشتقة من بيانات فعلية فقط، بلا تخمين. */
export function deriveAlerts(input: {
  branches: number;
  accounts: number;
  cashboxes: number;
  entries: number;
  totals: Record<string, CurrencyTotals>;
  orphanAccounts: string[];
  truncated: boolean;
}): DerivedAlert[] {
  const a: DerivedAlert[] = [];
  for (const [cur, t] of Object.entries(input.totals)) {
    if (!t.balanced) a.push({ id: `unbalanced-${cur}`, level: "high", key: "unbalancedCurrency", params: { currency: cur } });
  }
  if (input.orphanAccounts.length > 0) a.push({ id: "orphan", level: "high", key: "unknownAccount" });
  if (input.truncated) a.push({ id: "truncated", level: "high", key: "dataTruncated" });
  if (input.branches === 0) a.push({ id: "no-branches", level: "medium", key: "noBranches" });
  if (input.accounts === 0) a.push({ id: "no-accounts", level: "medium", key: "noAccounts" });
  if (input.cashboxes === 0) a.push({ id: "no-cashboxes", level: "info", key: "noCashboxes" });
  return a;
}

/** CSV آمن: اقتباس صحيح + حماية من حقن الصيغ في Excel + BOM لعرض العربية. */
export function toCSV(rows: string[][]): string {
  const numeric = /^-?\d+(\.\d+)?$/;
  const cell = (raw: string) => {
    let s = String(raw ?? "");
    if (!numeric.test(s) && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "\uFEFF" + rows.map((r) => r.map(cell).join(",")).join("\r\n");
}
