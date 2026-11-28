"use client";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Send, ShieldCheck, Sparkles, TrendingUp, Users, Wand2, Zap } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { invokeAiCfo, invokeAiCommand, type AiCommandResult, type AiQuota } from "@/lib/aiBrain";
import { formatMinor, parseMinor } from "@/lib/money";

type Branch = { id: string; name: string };
type Account = { id: string; code: string; name: string; type: string };
type Currency = { code: string; decimals: number };
type ContactRow = { id: string; name: string; phone: string | null; balance_minor: string | number; currency: string };
type ProductBrief = { id: string; name: string; track_stock: boolean };
type Props = {
  mode: "home" | "contacts" | "ai";
  orgId: string; role: string | null;
  branches: Branch[]; accounts: Account[]; currencies: Currency[];
  notify: (type: "ok" | "err", text: string) => void;
  askConfirm: (title: string, msg: string, run: () => void) => void;
  onReload: () => void;
};

const ZERO = BigInt(0);
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

export function SmartAiHub({ mode, orgId, role, branches, accounts, currencies, notify, askConfirm, onReload }: Props) {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [busy, setBusy] = useState(false);
  const [cmd, setCmd] = useState("");
  const [quota, setQuota] = useState<AiQuota | null>(null);
  const [modelName, setModelName] = useState<string>("");
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [products, setProducts] = useState<ProductBrief[]>([]);
  const [stock, setStock] = useState<Record<string, string>>({});
  const [chatInput, setChatInput] = useState("");
  const [chat, setChat] = useState<Array<{ who: "ai" | "user"; text: string }>>([
    { who: "ai", text: "أهلاً بك في المستشار المالي التنفيذي (Sama AI CFO — مدعوم بـ Gemini الحقيقي). أقرأ أرقامك الحية مباشرةً من PostgreSQL بدقة BigInt 100% ولا أعدّل أي سجل دون موافقتك الصريحة. اختر سؤالاً سريعاً أو اسألني أي شيء!" },
  ]);

  const decOf = (c: string) => currencies.find((x) => x.code === c)?.decimals ?? 2;
  const pickCurr = (c?: string) => (c && currencies.some((x) => x.code === c.toUpperCase()) ? c.toUpperCase() : (currencies[0]?.code ?? "USD"));
  const canAdmin = role ? ["owner", "admin"].includes(role) : false;
  const canOperate = role ? ["owner", "admin", "accountant", "cashier"].includes(role) : false;

  const loadSmartData = useCallback(async () => {
    if (!orgId) return;
    const [cRes, pRes, sRes] = await Promise.all([
      supabase.from("contacts").select("id,name,phone,balance_minor,currency").eq("org_id", orgId).order("balance_minor", { ascending: false }),
      supabase.from("products").select("id,name,track_stock").eq("org_id", orgId),
      supabase.from("v_stock_on_hand").select("product_id,qty_milli").eq("org_id", orgId),
    ]);
    setContacts((cRes.data as ContactRow[]) ?? []);
    setProducts((pRes.data as ProductBrief[]) ?? []);
    const sm: Record<string, string> = {};
    for (const r of (sRes.data as Array<{ product_id: string; qty_milli: string }> | null) ?? []) sm[r.product_id] = r.qty_milli;
    setStock(sm);
  }, [orgId]);

  useEffect(() => { void loadSmartData(); }, [loadSmartData]);

  async function runAutoBootstrap() {
    setBusy(true);
    const { error } = await supabase.rpc("auto_bootstrap_org", { p_org: orgId });
    setBusy(false);
    if (error) return notifyRef.current("err", `تعذرت التهيئة: ${error.message}`);
    notifyRef.current("ok", "تمت التهيئة التلقائية للفرع ودليل الحسابات وربط الفواتير بنجاح");
    onReload();
  }

  function confirmAndRunAiCommand(parsed: AiCommandResult) {
    if (parsed.action === "question") {
      notifyRef.current("ok", parsed.reply_ar);
      return;
    }
    const curr = pickCurr(parsed.currency);
    const d = decOf(curr);
    const br = branches[0]?.id;
    askConfirm(
      "اعتماد أمر Gemini الذكي",
      `${parsed.summary_ar} — المبلغ: ${parsed.amount ?? "—"} ${curr}. تنفيذ وترحيل القيد بدقة BigInt 100%؟`,
      async () => {
        try {
          setBusy(true);
          if (parsed.action === "expense") {
            if (!br) throw new Error("اضغط التهيئة الذكية أولاً لإنشاء الفرع");
            const amt = parseMinor(parsed.amount ?? "0", d);
            const { error } = await supabase.rpc("post_smart_expense", {
              p_org: orgId, p_branch: br, p_date: todayISO(), p_currency: curr,
              p_amount_minor: amt.toString(), p_memo: parsed.memo || parsed.summary_ar, p_key: `cmd-exp-${Date.now()}`,
            });
            if (error) throw new Error(error.message);
          } else if (parsed.action === "debt_in") {
            if (!br) throw new Error("اضغط التهيئة الذكية أولاً لإنشاء الفرع");
            const amt = parseMinor(parsed.amount ?? "0", d);
            const { error } = await supabase.rpc("post_smart_debt_in", {
              p_org: orgId, p_branch: br, p_date: todayISO(), p_currency: curr,
              p_amount_minor: amt.toString(), p_party: parsed.party_name || "دائن",
              p_memo: parsed.memo || parsed.summary_ar, p_key: `cmd-debt-${Date.now()}`,
            });
            if (error) throw new Error(error.message);
          } else if (parsed.action === "add_product") {
            const price = parseMinor(parsed.amount ?? "0", d);
            const { error } = await supabase.rpc("upsert_quick_product", {
              p_org: orgId, p_name: parsed.product_name || parsed.summary_ar,
              p_currency: curr, p_price_minor: price.toString(), p_cost_minor: "0", p_track_stock: false,
            });
            if (error) throw new Error(error.message);
          } else if (parsed.action === "debt_collect") {
            if (!br || !parsed.contact_id) throw new Error("لم يتم العثور على العميل — نفّذ التحصيل من تبويب الديون");
            const amt = parseMinor(parsed.amount ?? "0", d);
            const { error } = await supabase.rpc("post_debt_collection", {
              p_org: orgId, p_branch: br, p_contact: parsed.contact_id, p_date: todayISO(),
              p_amount_minor: amt.toString(), p_key: `cmd-col-${Date.now()}`,
            });
            if (error) throw new Error(error.message);
          } else if (parsed.action === "quick_sale") {
            if (!br) throw new Error("اضغط التهيئة الذكية أولاً لإنشاء الفرع");
            const { data: uData } = await supabase.auth.getUser();
            const uid = uData.user?.id;
            if (!uid) throw new Error("يرجى إعادة تسجيل الدخول");
            let pid = parsed.product_id || "";
            const qtyMilli = parseMinor(parsed.qty || "1", 3);
            const totalMinor = parseMinor(parsed.amount || "0", d);
            const unitMinor = qtyMilli > ZERO ? (totalMinor * BigInt(1000)) / qtyMilli : totalMinor;
            if (!pid) {
              const { data: qp, error: qe } = await supabase.rpc("upsert_quick_product", {
                p_org: orgId, p_name: parsed.product_name || "مبيعات سريعة",
                p_currency: curr, p_price_minor: unitMinor.toString(), p_cost_minor: "0", p_track_stock: false,
              });
              if (qe || !qp) throw new Error(qe?.message ?? "تعذر إنشاء الصنف");
              pid = (qp as { id: string }).id;
            }
            const { data: inv, error: e1 } = await supabase.from("invoices").insert({
              org_id: orgId, branch_id: br, kind: "sales", number: `AI-${Date.now().toString().slice(-6)}`,
              party_name: parsed.party_name || null, currency: curr, issue_date: todayISO(),
              status: "draft", total_minor: totalMinor.toString(), created_by: uid,
            }).select("id").single();
            if (e1 || !inv) throw new Error(e1?.message ?? "تعذر إنشاء الفاتورة");
            const { error: e2 } = await supabase.from("invoice_lines").insert({
              invoice_id: inv.id, org_id: orgId, product_id: pid,
              qty_milli: qtyMilli.toString(), unit_minor: unitMinor.toString(), discount_bp: 0, tax_bp: 0,
            });
            if (e2) throw new Error(e2.message);
            const paidMinor = parsed.payment_mode === "credit" ? ZERO : (parsed.payment_mode === "partial" ? parseMinor(parsed.paid_amount || "0", d) : totalMinor);
            const { error: e3 } = await supabase.rpc("post_sales_invoice_pro", {
              p_invoice: inv.id, p_paid_minor: paidMinor.toString(),
              p_contact_id: parsed.contact_id || null, p_due_date: null, p_key: `cmd-sale-${inv.id}`,
            });
            if (e3) throw new Error(e3.message);
          }
          setBusy(false);
          setCmd("");
          notifyRef.current("ok", `تم التنفيذ بنجاح بدقة BigInt 100%: ${parsed.summary_ar}`);
          void loadSmartData();
          onReload();
        } catch (ex) {
          setBusy(false);
          notifyRef.current("err", ex instanceof Error ? ex.message : "تعذر تنفيذ الأمر");
        }
      }
    );
  }

  async function handleSmartCommand(e: FormEvent) {
    e.preventDefault();
    const raw = cmd.trim();
    if (!raw) return;
    setBusy(true);
    try {
      const res = await invokeAiCommand(orgId, raw);
      setQuota(res.quota);
      setModelName(res.model);
      setBusy(false);
      confirmAndRunAiCommand(res.result);
    } catch (ex) {
      setBusy(false);
      notifyRef.current("err", `تعذر الاتصال بعقل Gemini: ${ex instanceof Error ? ex.message : "خطأ"}`);
    }
  }

  async function askCfo(question: string) {
    const q = question.trim();
    if (!q) return;
    setChatInput("");
    setChat((prev) => [...prev, { who: "user", text: q }, { who: "ai", text: "جارٍ تحليل أرقامك الحية من PostgreSQL عبر Gemini..." }]);
    setBusy(true);
    try {
      const res = await invokeAiCfo(orgId, q);
      setQuota(res.quota);
      setModelName(res.model);
      setChat((prev) => [...prev.slice(0, -1), { who: "ai", text: res.reply }]);
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : "تأكد من تنفيذ SQL الحصص والسياق في Supabase";
      setChat((prev) => [...prev.slice(0, -1), { who: "ai", text: `تعذر الاتصال بـ Gemini حالياً: ${msg}` }]);
    } finally {
      setBusy(false);
    }
  }

  function handleAskCfo(e: FormEvent) {
    e.preventDefault();
    void askCfo(chatInput);
  }

  const lowStockProducts = products.filter((p) => p.track_stock && BigInt(stock[p.id] ?? "0") <= BigInt(5000));
  const totalDebtByCurr: Record<string, bigint> = {};
  for (const c of contacts) {
    const b = BigInt(c.balance_minor);
    if (b > ZERO) totalDebtByCurr[c.currency] = (totalDebtByCurr[c.currency] ?? ZERO) + b;
  }

  if (mode === "home") {
    const needsSetup = branches.length === 0 || accounts.length < 5;
    return (
      <div className="space-y-3 mb-4">
        {needsSetup && canAdmin && (
          <div className="bg-white border border-[#E4EAF2] rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 shadow-sm">
            <div className="space-y-1">
              <div className="font-bold text-sm text-[#152743] flex items-center gap-1.5"><Zap className="w-4 h-4 text-[#C5A46D]" /> التهيئة الذكية الفورية (بدون تعقيد محاسبي)</div>
              <p className="text-xs text-[#68778D]">بضغطة واحدة يُنشئ النظام الفرع الرئيسي ودليل الحسابات الكامل ويربط الفواتير والمخزون تلقائياً.</p>
            </div>
            <button type="button" disabled={busy} onClick={() => void runAutoBootstrap()} className="bg-[#2869DB] hover:bg-[#1F57BC] text-white px-4 py-2.5 rounded-xl text-xs font-bold flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" /> {busy ? "جارٍ التهيئة..." : "تهيئة ذكية بضغطة زر"}
            </button>
          </div>
        )}

        <div className="bg-white border border-[#E4EAF2] rounded-2xl p-4 space-y-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-bold text-sm text-[#152743] flex items-center gap-2"><Sparkles className="w-4 h-4 text-[#2869DB]" /> مركز القيادة الذكي — Gemini AI + BigInt 100%</div>
            <span className="text-[11px] inline-flex items-center gap-1 font-semibold px-2.5 py-1 rounded-full bg-[#ECFDF3] text-[#15803D]">
              <ShieldCheck className="w-3.5 h-3.5" />
              {quota ? `الرصيد اليومي: ${quota.remaining} / ${quota.limit}` : "عقل خادمي آمن"}
            </span>
          </div>

          {canOperate && (
            <form onSubmit={handleSmartCommand} className="flex flex-col sm:flex-row gap-2">
              <input
                value={cmd}
                onChange={(e) => setCmd(e.target.value)}
                placeholder="اكتب بأي لهجة: «بعت 2 رصيد لأبو أحمد 20$ آجل» أو «دفعت كهرباء 15$»..."
                className="flex-1 min-w-0 w-full px-3.5 py-2.5 text-xs bg-[#F7F9FC] border border-[#E4EAF2] rounded-xl text-[#152743] outline-none focus:bg-white focus:border-[#2869DB]"
              />
              <button
                type="submit"
                disabled={busy}
                className="shrink-0 bg-[#2869DB] hover:bg-[#1F57BC] text-white px-5 py-2.5 rounded-xl text-xs font-bold inline-flex items-center justify-center gap-1.5"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />} نفّذ بـ Gemini
              </button>
            </form>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-[#152743]">
            <div className="p-2.5 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] flex items-center gap-2">
              {lowStockProducts.length > 0 ? <AlertTriangle className="w-4 h-4 text-[#C2410C] shrink-0" /> : <CheckCircle2 className="w-4 h-4 text-[#15803D] shrink-0" />}
              <span>{lowStockProducts.length > 0 ? `تنبيه مخزون: ${lowStockProducts.length} أصناف قريبة من النفاد` : `المخزون مستقر (${products.length} صنف)`}</span>
            </div>
            <div className="p-2.5 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] flex items-center gap-2">
              <Users className="w-4 h-4 text-[#2869DB] shrink-0" />
              <span className="truncate">الديون المعلقة: {Object.entries(totalDebtByCurr).map(([k, v]) => `${formatMinor(v, decOf(k))} ${k}`).join(" | ") || "لا توجد ديون"}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-[#E4EAF2] rounded-2xl p-4 sm:p-5 space-y-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E4EAF2] pb-3">
        <div>
          <h2 className="font-bold text-base text-[#152743] flex items-center gap-2"><Sparkles className="w-5 h-5 text-[#2869DB]" /> المستشار المالي التنفيذي (Gemini AI CFO)</h2>
          <p className="text-xs text-[#68778D]">يحلل أرقامك الحية مباشرةً من قاعدة البيانات ولا يعدّل أي قيد تلقائياً</p>
        </div>
        <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-[#ECFDF3] text-[#15803D] inline-flex items-center gap-1">
          <ShieldCheck className="w-3.5 h-3.5" />
          {modelName ? `${modelName} • ` : ""}{quota ? `المتبقي اليوم: ${quota.remaining}` : "متصل بـ PostgreSQL"}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {[
          "حلل وضعي المالي اليوم وتوقع التدفق النقدي للشهر القادم",
          "ما هي أكبر نقاط تسرب الربح والمنتجات الراكدة أو الخاسرة لدي؟",
          "أعطني خطة عملية من 3 خطوات لتحصيل الديون ورفع السيولة هذا الأسبوع",
        ].map((q) => (
          <button key={q} type="button" disabled={busy} onClick={() => void askCfo(q)} className="px-3 py-2 bg-[#F7F9FC] hover:bg-[#EDF2F8] text-[#152743] border border-[#E4EAF2] rounded-xl text-xs font-bold inline-flex items-center gap-1.5 text-start">
            <TrendingUp className="w-3.5 h-3.5 text-[#2869DB] shrink-0" /> {q}
          </button>
        ))}
      </div>

      <div className="space-y-2.5 max-h-96 overflow-y-auto p-3 bg-[#F7F9FC] border border-[#E4EAF2] rounded-2xl">
        {chat.map((m, i) => (
          <div
            key={i}
            className={`p-3 rounded-2xl text-xs whitespace-pre-line leading-relaxed ${
              m.who === "user"
                ? "bg-[#2869DB] text-white ms-6 font-semibold"
                : "bg-white text-[#152743] border border-[#E4EAF2] me-6"
            }`}
          >
            {m.text}
          </div>
        ))}
      </div>

      <form onSubmit={handleAskCfo} className="flex flex-col sm:flex-row gap-2">
        <input
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          placeholder="اسأل المستشار المالي عن الأرباح، المخزون، الديون، أو توقع الشهر القادم..."
          className="flex-1 min-w-0 w-full px-3.5 py-2.5 text-xs bg-[#F7F9FC] border border-[#E4EAF2] rounded-xl text-[#152743] outline-none focus:bg-white focus:border-[#2869DB]"
        />
        <button type="submit" disabled={busy} className="shrink-0 bg-[#2869DB] hover:bg-[#1F57BC] text-white px-5 py-2.5 rounded-xl text-xs font-bold inline-flex items-center justify-center gap-1.5">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} اسأل Gemini
        </button>
      </form>
    </div>
  );
}
