"use client";
import { useCallback, useEffect, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, FileSpreadsheet, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatMinor } from "@/lib/money";

type Currency = { code: string; decimals: number };
type SummaryRow = { account_id: string; code: string; name: string; type: string; currency: string; debit: string; credit: string };
type EntryLine = { account_id: string; account_code: string; account_name: string; currency: string; debit: string; credit: string };
type EntryItem = { id: string; entry_date: string; memo: string; lines: EntryLine[] };
type Props = { orgId: string; defaultCurrency: string; currencies: Currency[] };

const ZERO = BigInt(0);

export function CompleteLedgerView({ orgId, defaultCurrency, currencies }: Props) {
  const [curr, setCurr] = useState(defaultCurrency || "USD");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [totalEntries, setTotalEntries] = useState(0);
  const [totalLines, setTotalLines] = useState(0);
  const [summaryRows, setSummaryRows] = useState<SummaryRow[]>([]);
  const [pageTotal, setPageTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [items, setItems] = useState<EntryItem[]>([]);

  useEffect(() => {
    if (defaultCurrency) setCurr(defaultCurrency);
  }, [defaultCurrency]);

  const decOf = (c: string) => currencies.find((x) => x.code === c)?.decimals ?? 2;

  const loadAll = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    setLoadError(null);
    const [sumRes, pageRes] = await Promise.all([
      supabase.rpc("get_financial_summary", {
        p_org: orgId,
        p_from: fromDate || null,
        p_to: toDate || null,
      }),
      supabase.rpc("list_journal_entries_page", {
        p_org: orgId,
        p_page: page,
        p_page_size: pageSize,
        p_from: fromDate || null,
        p_to: toDate || null,
        p_search: search.trim() || null,
      }),
    ]);

    if (sumRes.error || pageRes.error) {
      setLoadError(sumRes.error?.message || pageRes.error?.message || "تعذر تحميل البيانات الكاملة");
      setBusy(false);
      return;
    }

    const sData = sumRes.data as { total_entries: number; total_lines: number; accounts: SummaryRow[] } | null;
    if (sData) {
      setTotalEntries(Number(sData.total_entries ?? 0));
      setTotalLines(Number(sData.total_lines ?? 0));
      setSummaryRows(sData.accounts ?? []);
    }

    const pData = pageRes.data as { total: number; total_pages: number; items: EntryItem[] } | null;
    if (pData) {
      setPageTotal(Number(pData.total ?? 0));
      setTotalPages(Math.max(1, Number(pData.total_pages ?? 1)));
      setItems(pData.items ?? []);
    }
    setBusy(false);
  }, [orgId, fromDate, toDate, page, pageSize, search]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const currRows = summaryRows.filter((r) => r.currency === curr);
  const d = decOf(curr);

  let rev = ZERO, exp = ZERO, assets = ZERO, liab = ZERO, totD = ZERO, totC = ZERO;
  for (const r of currRows) {
    const db = BigInt(r.debit || "0");
    const cr = BigInt(r.credit || "0");
    totD += db; totC += cr;
    if (r.type === "revenue") rev += cr - db;
    if (r.type === "expense") exp += db - cr;
    if (r.type === "asset") assets += db - cr;
    if (r.type === "liability") liab += cr - db;
  }
  const netProfit = rev - exp;
  const balanced = totD === totC;

  return (
    <div className="space-y-4 my-4">
      {loadError && (
        <div className="p-3.5 rounded-2xl border border-rose-300 bg-rose-50 text-rose-800 text-xs flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-bold"><AlertCircle className="w-4 h-4 shrink-0" /> فشل التحديث (تم الحفاظ على البيانات السابقة): {loadError}</span>
          <button type="button" onClick={() => void loadAll()} className="px-3 py-1.5 rounded-xl bg-rose-700 text-white font-bold">إعادة المحاولة</button>
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="font-bold text-base flex items-center gap-2"><FileSpreadsheet className="w-5 h-5" /> التقارير المالية الكاملة (من كامل قاعدة البيانات)</h3>
            <p className="text-xs text-slate-400">محسوبة داخل PostgreSQL بدون حد 50 قيداً أو 1000 سطر — إجمالي القيود: {totalEntries} ({totalLines} سطر)</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={curr} onChange={(e) => setCurr(e.target.value)} className="px-3 py-1.5 text-xs border rounded-xl">
              {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </select>
            <input type="date" value={fromDate} onChange={(e) => { setPage(1); setFromDate(e.target.value); }} className="px-2.5 py-1.5 text-xs border rounded-xl" />
            <input type="date" value={toDate} onChange={(e) => { setPage(1); setToDate(e.target.value); }} className="px-2.5 py-1.5 text-xs border rounded-xl" />
            <button type="button" onClick={() => void loadAll()} className="p-2 bg-slate-800 rounded-xl"><RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} /></button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
          <div className="p-3 rounded-xl border border-slate-800"><span className="block text-slate-400">الإيرادات ({curr})</span><strong className="text-sm">{formatMinor(rev, d)}</strong></div>
          <div className="p-3 rounded-xl border border-slate-800"><span className="block text-slate-400">المصروفات ({curr})</span><strong className="text-sm">{formatMinor(exp, d)}</strong></div>
          <div className="p-3 rounded-xl border border-slate-800"><span className="block text-slate-400">صافي الربح ({curr})</span><strong className="text-sm">{formatMinor(netProfit, d)}</strong></div>
          <div className="p-3 rounded-xl border border-slate-800"><span className="block text-slate-400">الأصول ({curr})</span><strong className="text-sm">{formatMinor(assets, d)}</strong></div>
          <div className="p-3 rounded-xl border border-slate-800"><span className="block text-slate-400">الالتزامات ({curr})</span><strong className="text-sm">{formatMinor(liab, d)}</strong></div>
        </div>

        <div className="text-xs font-bold flex items-center gap-1.5">
          <ShieldCheck className="w-4 h-4" />
          <span>{balanced ? `ميزان المراجعة متوازن 100% — إجمالي المدين = الدائن = ${formatMinor(totD, d)} ${curr}` : "تنبيه: راجع التوازن"}</span>
        </div>
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="font-bold text-sm">دفتر القيود الكامل بالترقيم الصفحي ({pageTotal} قيد)</h4>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute right-2.5 top-2.5 text-slate-400" />
              <input value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} placeholder="بحث في البيان..." className="pr-8 pl-3 py-1.5 text-xs border rounded-xl w-44" />
            </div>
            <select value={pageSize} onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }} className="px-2.5 py-1.5 text-xs border rounded-xl">
              <option value={25}>25 / صفحة</option>
              <option value={50}>50 / صفحة</option>
              <option value={100}>100 / صفحة</option>
            </select>
          </div>
        </div>

        <div className="space-y-2.5">
          {items.map((e) => (
            <div key={e.id} className="p-3 rounded-xl border border-slate-800 space-y-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="text-sm">{e.memo || "قيد محاسبي"}</strong>
                <span className="text-slate-400" dir="ltr">{e.entry_date}</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="border-b border-slate-800 text-slate-400">
                    <tr><th className="py-1 text-start">الحساب</th><th className="py-1 text-end">مدين</th><th className="py-1 text-end">دائن</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {e.lines.map((l, i) => {
                      const ld = decOf(l.currency);
                      return (
                        <tr key={i}>
                          <td className="py-1">{l.account_code} — {l.account_name}</td>
                          <td className="py-1 text-end">{BigInt(l.debit) > ZERO ? `${formatMinor(l.debit, ld)} ${l.currency}` : "—"}</td>
                          <td className="py-1 text-end">{BigInt(l.credit) > ZERO ? `${formatMinor(l.credit, ld)} ${l.currency}` : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {items.length === 0 && !busy && <p className="text-xs text-slate-400 py-2">لا توجد قيود مطابقة للبحث.</p>}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-slate-800 text-xs">
          <button type="button" disabled={page <= 1 || busy} onClick={() => setPage((p) => Math.max(1, p - 1))} className="px-3 py-1.5 bg-slate-800 rounded-xl inline-flex items-center gap-1 disabled:opacity-40">
            <ChevronRight className="w-4 h-4" /> السابق
          </button>
          <span className="font-bold">صفحة {page} من {totalPages}</span>
          <button type="button" disabled={page >= totalPages || busy} onClick={() => setPage((p) => Math.min(totalPages, p + 1))} className="px-3 py-1.5 bg-slate-800 rounded-xl inline-flex items-center gap-1 disabled:opacity-40">
            التالي <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
