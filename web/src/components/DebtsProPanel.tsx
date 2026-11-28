"use client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Clock, CreditCard, FileText, MessageCircle, Plus, RefreshCw, Users, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatMinor, parseMinor } from "@/lib/money";

type Branch = { id: string; name: string };
type Currency = { code: string; decimals: number };
type AgingSum = { currency: string; total_minor: string; current_minor: string; overdue_1_30: string; overdue_31_60: string; overdue_60_plus: string; debtors_count: number };
type DebtContact = {
  id: string; name: string; phone: string | null; kind: string; currency: string;
  balance_minor: string; credit_limit_minor: string; due_date: string | null;
  notes: string | null; overdue_days: number; utilization_pct: number;
};
type TxRow = { id: number; kind: string; amount_minor: string; balance_after_minor: string; currency: string; note: string | null; created_at: string };
type Props = {
  orgId: string; role: string | null; branches: Branch[]; currencies: Currency[];
  notify: (type: "ok" | "err", text: string) => void;
  askConfirm: (title: string, msg: string, run: () => void) => void;
  onReload: () => void;
};

const ZERO = BigInt(0);
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export function DebtsProPanel({ orgId, role, branches, currencies, notify, askConfirm, onReload }: Props) {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<AgingSum[]>([]);
  const [contacts, setContacts] = useState<DebtContact[]>([]);
  const [filterOnlyDebt, setFilterOnlyDebt] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [curr, setCurr] = useState(currencies[0]?.code ?? "USD");
  const [bal, setBal] = useState("0");
  const [limit, setLimit] = useState("0");
  const [due, setDue] = useState("");
  const [payAmounts, setPayAmounts] = useState<Record<string, string>>({});
  const [stmtContact, setStmtContact] = useState<DebtContact | null>(null);
  const [stmtRows, setStmtRows] = useState<TxRow[]>([]);

  const canOperate = role ? ["owner", "admin", "accountant", "cashier"].includes(role) : false;
  const decOf = (c: string) => currencies.find((x) => x.code === c)?.decimals ?? 2;

  const loadDebts = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("get_debts_aging_report", { p_org: orgId });
    setBusy(false);
    if (error) return notify("err", `تعذر تحميل تقرير الديون: ${error.message}`);
    const payload = data as { summary?: AgingSum[]; contacts?: DebtContact[] } | null;
    setSummary(payload?.summary ?? []);
    setContacts(payload?.contacts ?? []);
  }, [orgId, notify]);

  useEffect(() => { void loadDebts(); }, [loadDebts]);

  async function addContact(e: FormEvent) {
    e.preventDefault();
    try {
      const d = decOf(curr);
      const bMin = parseMinor(bal || "0", d);
      const lMin = parseMinor(limit || "0", d);
      if (bMin < ZERO || lMin < ZERO) return notify("err", "القيم يجب أن تكون موجبة");
      setBusy(true);
      const { error } = await supabase.from("contacts").insert({
        org_id: orgId, name: name.trim(), phone: phone.trim() || null,
        kind: "customer", balance_minor: bMin.toString(),
        credit_limit_minor: lMin.toString(), currency: curr, due_date: due || null,
      });
      setBusy(false);
      if (error) return notify("err", `تعذر الحفظ: ${error.message}`);
      setName(""); setPhone(""); setBal("0"); setLimit("0"); setDue("");
      notify("ok", "تم حفظ العميل والسقف الائتماني بنجاح ✓");
      void loadDebts();
    } catch (ex) { notify("err", ex instanceof Error ? ex.message : "بيانات غير صالحة"); }
  }

  function collect(c: DebtContact) {
    const br = branches[0]?.id;
    if (!br) return notify("err", "اضغط التهيئة الذكية أولاً لإنشاء الفرع");
    try {
      const d = decOf(c.currency);
      const rawAmt = (payAmounts[c.id] ?? "").trim();
      const amtMinor = rawAmt ? parseMinor(rawAmt, d) : BigInt(c.balance_minor);
      if (amtMinor <= ZERO || amtMinor > BigInt(c.balance_minor)) {
        return notify("err", "مبلغ التحصيل يجب أن يكون أكبر من 0 ولا يتجاوز الدين");
      }
      askConfirm("سند قبض وتحصيل دين", `تحصيل ${formatMinor(amtMinor, d)} ${c.currency} من «${c.name}» وترحيل القيد تلقائياً؟`, async () => {
        setBusy(true);
        const { error } = await supabase.rpc("post_debt_collection", {
          p_org: orgId, p_branch: br, p_contact: c.id, p_date: todayISO(),
          p_amount_minor: amtMinor.toString(), p_key: `col-${c.id}-${Date.now()}`,
        });
        setBusy(false);
        if (error) return notify("err", `تعذر التحصيل: ${error.message}`);
        setPayAmounts((p) => ({ ...p, [c.id]: "" }));
        notify("ok", "تم تسجيل سند القبض وتحديث كشف الحساب بدقة 100% ✓");
        void loadDebts(); onReload();
      });
    } catch (ex) { notify("err", ex instanceof Error ? ex.message : "مبلغ غير صالح"); }
  }

  async function openStatement(c: DebtContact) {
    setStmtContact(c);
    const { data } = await supabase.from("contact_transactions").select("id,kind,amount_minor,balance_after_minor,currency,note,created_at").eq("org_id", orgId).eq("contact_id", c.id).order("created_at", { ascending: false }).limit(50);
    setStmtRows((data as TxRow[]) ?? []);
  }

  function shareReminder(c: DebtContact) {
    const amt = `${formatMinor(c.balance_minor, decOf(c.currency))} ${c.currency}`;
    const dueTxt = c.due_date ? ` (تاريخ الاستحقاق: ${c.due_date})` : "";
    const msg = `السلام عليكم أستاذ ${c.name}، تذكير لطيف بالرصيد المستحق البالغ ${amt}${dueTxt}. نشكركم دائماً على حسن تعاملكم.`;
    if (navigator.clipboard) void navigator.clipboard.writeText(msg);
    notify("ok", "تم نسخ رسالة التذكير — الصقها في واتساب مباشرةً ✓");
  }

  const shown = filterOnlyDebt ? contacts.filter((c) => BigInt(c.balance_minor) > ZERO) : contacts;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-base flex items-center gap-2"><Users className="w-5 h-5" /> إدارة الديون الدقيقة وأعمار الذمم</h2>
        <div className="flex gap-2">
          <button type="button" onClick={() => setFilterOnlyDebt((v) => !v)} className={`px-3 py-1.5 rounded-xl text-xs font-bold ${filterOnlyDebt ? "bg-emerald-600 text-white" : "bg-slate-800"}`}>
            {filterOnlyDebt ? "المدينون فقط ✓" : "عرض المدينين فقط"}
          </button>
          <button type="button" onClick={() => void loadDebts()} className="px-3 py-1.5 bg-slate-800 rounded-xl text-xs inline-flex items-center gap-1"><RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} /> تحديث</button>
        </div>
      </div>

      {/* أعمار الديون لكل عملة بدقة BigInt */}
      {summary.map((s) => {
        const d = decOf(s.currency);
        return (
          <div key={s.currency} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
            <div className="flex items-center justify-between text-sm font-bold">
              <span>إجمالي الذمم ({s.currency}) — {s.debtors_count} مدين</span>
              <span>{formatMinor(s.total_minor, d)} {s.currency}</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div className="p-2.5 rounded-xl border border-slate-800"><div className="text-slate-400">حالي (غير متأخر)</div><strong>{formatMinor(s.current_minor, d)}</strong></div>
              <div className="p-2.5 rounded-xl border border-slate-800"><div className="text-slate-400">متأخر 1–30 يوماً</div><strong>{formatMinor(s.overdue_1_30, d)}</strong></div>
              <div className="p-2.5 rounded-xl border border-slate-800"><div className="text-slate-400">متأخر 31–60 يوماً</div><strong>{formatMinor(s.overdue_31_60, d)}</strong></div>
              <div className="p-2.5 rounded-xl border border-slate-800"><div className="text-slate-400">حرج (+60 يوماً)</div><strong>{formatMinor(s.overdue_60_plus, d)}</strong></div>
            </div>
          </div>
        );
      })}

      {canOperate && (
        <form onSubmit={addContact} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h3 className="font-bold text-sm flex items-center gap-1.5"><CreditCard className="w-4 h-4" /> إضافة عميل مع سقف ائتماني وتاريخ استحقاق</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم العميل" className="px-3 py-2 text-xs border" />
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="رقم الهاتف" className="px-3 py-2 text-xs border" />
            <select value={curr} onChange={(e) => setCurr(e.target.value)} className="px-3 py-2 text-xs border">{currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select>
            <input value={bal} onChange={(e) => setBal(e.target.value)} inputMode="decimal" placeholder="رصيد دين ابتدائي" className="px-3 py-2 text-xs border" />
            <input value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="decimal" placeholder="السقف الائتماني (0 = مفتوح)" className="px-3 py-2 text-xs border" />
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} title="تاريخ الاستحقاق" className="px-3 py-2 text-xs border" />
          </div>
          <button disabled={busy} className="bg-emerald-600 text-white px-4 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> حفظ العميل</button>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {shown.map((c) => {
          const d = decOf(c.currency);
          const hasDebt = BigInt(c.balance_minor) > ZERO;
          const hasLimit = BigInt(c.credit_limit_minor) > ZERO;
          return (
            <div key={c.id} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-bold text-sm">{c.name}</div>
                  <div className="text-slate-400">{c.phone ?? "بدون هاتف"}{c.due_date ? ` • استحقاق: ${c.due_date}` : ""}</div>
                </div>
                <div className="text-end">
                  <div className="font-bold text-sm">{hasDebt ? `${formatMinor(c.balance_minor, d)} ${c.currency}` : "خالص ✓"}</div>
                  {c.overdue_days > 0 && <span className="inline-flex items-center gap-1 font-bold"><AlertTriangle className="w-3.5 h-3.5" /> متأخر {c.overdue_days} يوماً</span>}
                </div>
              </div>

              {hasLimit && (
                <div className="space-y-1">
                  <div className="flex justify-between text-slate-400">
                    <span>السقف الائتماني: {formatMinor(c.credit_limit_minor, d)} {c.currency}</span>
                    <span>{c.utilization_pct}%</span>
                  </div>
                  <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div className="h-full bg-emerald-600 rounded-full" style={{ width: `${Math.min(100, c.utilization_pct)}%` }} />
                  </div>
                </div>
              )}

              {hasDebt && canOperate && (
                <div className="flex gap-1.5">
                  <input value={payAmounts[c.id] ?? ""} onChange={(e) => setPayAmounts((p) => ({ ...p, [c.id]: e.target.value }))} inputMode="decimal" placeholder={`مبلغ جزئي أو اتركه فارغاً للكل`} className="flex-1 px-2.5 py-1.5 border text-xs" />
                  <button type="button" onClick={() => collect(c)} className="px-3 py-1.5 bg-emerald-600 text-white rounded-xl font-bold">قبض</button>
                </div>
              )}

              <div className="flex gap-2">
                <button type="button" onClick={() => void openStatement(c)} className="flex-1 py-1.5 bg-slate-800 rounded-xl inline-flex items-center justify-center gap-1"><FileText className="w-3.5 h-3.5" /> كشف حساب</button>
                {hasDebt && <button type="button" onClick={() => shareReminder(c)} className="flex-1 py-1.5 bg-slate-800 rounded-xl inline-flex items-center justify-center gap-1"><MessageCircle className="w-3.5 h-3.5" /> تذكير واتساب</button>}
              </div>
            </div>
          );
        })}
      </div>

      {stmtContact && (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-sm flex items-center gap-1.5"><Clock className="w-4 h-4" /> كشف حساب تفصيلي: {stmtContact.name}</h3>
            <button type="button" onClick={() => setStmtContact(null)} className="p-1.5 bg-slate-800 rounded-lg"><X className="w-4 h-4" /></button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="border-b border-slate-800 text-slate-400"><tr><th className="py-2 text-start">التاريخ</th><th className="py-2 text-start">البيان</th><th className="py-2 text-end">المبلغ</th><th className="py-2 text-end">الرصيد بعد</th></tr></thead>
              <tbody className="divide-y divide-slate-800/70">
                {stmtRows.map((r) => (
                  <tr key={r.id}>
                    <td className="py-2" dir="ltr">{r.created_at.replace("T", " ").slice(0, 16)}</td>
                    <td className="py-2">{r.note ?? (r.kind === "payment" ? "تحصيل" : "ذمة")}</td>
                    <td className="py-2 text-end font-bold">{r.kind === "payment" ? "-" : "+"}{formatMinor(r.amount_minor, decOf(r.currency))} {r.currency}</td>
                    <td className="py-2 text-end">{formatMinor(r.balance_after_minor, decOf(r.currency))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stmtRows.length === 0 && <p className="text-xs text-slate-400 py-2">لا توجد حركات مسجلة في كشف الحساب بعد.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
