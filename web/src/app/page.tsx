"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import {
  AlertCircle,
  BookOpen,
  Building2,
  CheckCircle2,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { formatMinor, parseMinor } from "@/lib/money";
import schema from "@/lib/schema.json";

type Currency = { code: string; decimals: number };
type Org = { id: string; name: string; base_currency: string; created_at: string };
type Branch = { id: string; org_id: string; name: string };
type Account = { id: string; org_id: string; code: string; name: string; type: string; is_active: boolean };
type Cashbox = { id: string; org_id: string; branch_id: string; name: string; currency: string; account_id: string };
type JournalEntry = {
  id: string;
  branch_id: string;
  entry_date: string;
  memo: string | null;
  reverses_entry_id: string | null;
  created_at: string;
};
type JournalLine = {
  id: number;
  entry_id: string;
  account_id: string;
  currency: string;
  debit: number | string;
  credit: number | string;
};
type AuditLog = { id: number; action: string; entity: string; at: string };
type DraftLine = { account_id: string; currency: string; debit: string; credit: string };

const ACC_TYPE_AR: Record<string, string> = {
  asset: "أصول",
  liability: "التزامات",
  equity: "حقوق ملكية",
  revenue: "إيرادات",
  income: "إيرادات",
  expense: "مصروفات",
};

const todayISO = () => new Date().toISOString().slice(0, 10);

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [currencies, setCurrencies] = useState<Currency[]>([
    { code: "USD", decimals: 2 },
    { code: "SYP", decimals: 0 },
  ]);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string>("");
  const [tab, setTab] = useState<"overview" | "accounts" | "journal" | "controls">("overview");

  const [branches, setBranches] = useState<Branch[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [cashboxes, setCashboxes] = useState<Cashbox[]>([]);
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [lines, setLines] = useState<JournalLine[]>([]);
  const [audits, setAudits] = useState<AuditLog[]>([]);

  // Forms
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgCurr, setNewOrgCurr] = useState("USD");
  const [newBranchName, setNewBranchName] = useState("");
  const [accCode, setAccCode] = useState("");
  const [accName, setAccName] = useState("");
  const [accType, setAccType] = useState(schema.accountTypes[0] ?? "asset");
  const [cbName, setCbName] = useState("");
  const [cbBranch, setCbBranch] = useState("");
  const [cbAccount, setCbAccount] = useState("");
  const [cbCurr, setCbCurr] = useState("USD");

  // Journal form
  const [jeBranch, setJeBranch] = useState("");
  const [jeDate, setJeDate] = useState(todayISO());
  const [jeMemo, setJeMemo] = useState("");
  const [jeLines, setJeLines] = useState<DraftLine[]>([
    { account_id: "", currency: "USD", debit: "", credit: "" },
    { account_id: "", currency: "USD", debit: "", credit: "" },
  ]);

  // Controls
  const [closeDate, setCloseDate] = useState(todayISO());
  const [actCode, setActCode] = useState("");

  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null;
  const decimalsOf = (code: string) => currencies.find((c) => c.code === code)?.decimals ?? 2;

  const notify = (type: "ok" | "err", text: string) => setMsg({ type, text });

  const loadBase = useCallback(async () => {
    const [currRes, orgRes] = await Promise.all([
      supabase.from("currencies").select("code,decimals").order("code"),
      supabase.from("organizations").select("id,name,base_currency,created_at").order("created_at"),
    ]);
    if (orgRes.error) {
      notify(
        "err",
        `تعذر قراءة الجداول (${orgRes.error.message}). تأكد من تطبيق ملفات SQL الثلاثة في Supabase SQL Editor.`
      );
      return;
    }
    if (currRes.data && currRes.data.length > 0) {
      setCurrencies(currRes.data);
      setNewOrgCurr(currRes.data[0].code);
      setCbCurr(currRes.data[0].code);
    }
    const list = orgRes.data ?? [];
    setOrgs(list);
    if (list.length > 0) {
      setActiveOrgId((prev) => (list.some((o) => o.id === prev) ? prev : list[0].id));
    }
  }, []);

  const loadOrgData = useCallback(async (orgId: string) => {
    if (!orgId) return;
    setBusy(true);
    const [bRes, aRes, cRes, eRes, lRes, auRes] = await Promise.all([
      supabase.from("branches").select("*").eq("org_id", orgId).order("name"),
      supabase.from("accounts").select("*").eq("org_id", orgId).order("code"),
      supabase.from("cashboxes").select("*").eq("org_id", orgId).order("name"),
      supabase.from("journal_entries").select("*").eq("org_id", orgId).order("created_at", { ascending: false }).limit(50),
      supabase.from("journal_lines").select("*").eq("org_id", orgId),
      supabase.from("audit_logs").select("id,action,entity,at").eq("org_id", orgId).order("at", { ascending: false }).limit(30),
    ]);
    setBranches(bRes.data ?? []);
    setAccounts(aRes.data ?? []);
    setCashboxes(cRes.data ?? []);
    setEntries(eRes.data ?? []);
    setLines(lRes.data ?? []);
    setAudits(auRes.data ?? []);
    if (bRes.data?.[0]) {
      setJeBranch((p) => p || bRes.data![0].id);
      setCbBranch((p) => p || bRes.data![0].id);
    }
    if (aRes.data?.[0]) {
      setCbAccount((p) => p || aRes.data![0].id);
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (user) loadBase();
  }, [user, loadBase]);

  useEffect(() => {
    if (activeOrgId) loadOrgData(activeOrgId);
  }, [activeOrgId, loadOrgData]);

  async function handleAuth(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setBusy(true);
    const fn =
      authMode === "login"
        ? supabase.auth.signInWithPassword({ email, password })
        : supabase.auth.signUp({ email, password });
    const { error } = await fn;
    setBusy(false);
    if (error) return notify("err", error.message);
    if (authMode === "signup") {
      notify("ok", "تم إنشاء الحساب بنجاح. إذا لم يدخل تلقائياً، تأكد من إيقاف Confirm email في Supabase أو فعّل بريدك.");
    }
  }

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    if (!newOrgName.trim()) return;
    setBusy(true);
    setMsg(null);
    const { data, error } = await supabase.rpc("create_organization", {
      p_name: newOrgName.trim(),
      p_base_currency: newOrgCurr,
    });
    setBusy(false);
    if (error) return notify("err", error.message);
    setNewOrgName("");
    notify("ok", "تم إنشاء الشركة بنجاح");
    await loadBase();
    if (typeof data === "string") setActiveOrgId(data);
  }

  async function handleAddBranch(e: React.FormEvent) {
    e.preventDefault();
    if (!activeOrgId || !newBranchName.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("branches").insert({ org_id: activeOrgId, name: newBranchName.trim() });
    setBusy(false);
    if (error) return notify("err", error.message);
    setNewBranchName("");
    notify("ok", "تمت إضافة الفرع");
    loadOrgData(activeOrgId);
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!activeOrgId || !accCode.trim() || !accName.trim()) return;
    setBusy(true);
    const { error } = await supabase.from("accounts").insert({
      org_id: activeOrgId,
      code: accCode.trim(),
      name: accName.trim(),
      type: accType,
      is_active: true,
    });
    setBusy(false);
    if (error) return notify("err", error.message);
    setAccCode("");
    setAccName("");
    notify("ok", "تمت إضافة الحساب");
    loadOrgData(activeOrgId);
  }

  async function handleAddCashbox(e: React.FormEvent) {
    e.preventDefault();
    if (!activeOrgId || !cbName.trim() || !cbBranch || !cbAccount) return;
    setBusy(true);
    const { error } = await supabase.from("cashboxes").insert({
      org_id: activeOrgId,
      branch_id: cbBranch,
      name: cbName.trim(),
      currency: cbCurr,
      account_id: cbAccount,
    });
    setBusy(false);
    if (error) return notify("err", error.message);
    setCbName("");
    notify("ok", "تمت إضافة الصندوق");
    loadOrgData(activeOrgId);
  }

  async function handlePostJournal(e: React.FormEvent) {
    e.preventDefault();
    if (!activeOrgId || !jeBranch) return notify("err", "اختر الفرع أولاً");
    setMsg(null);
    try {
      const totals = new Map<string, { dr: bigint; cr: bigint }>();
      const rpcLines = jeLines.map((l, idx) => {
        if (!l.account_id) throw new Error(`اختر الحساب في السطر ${idx + 1}`);
        const dec = decimalsOf(l.currency);
        const dr = parseMinor(l.debit, dec);
        const cr = parseMinor(l.credit, dec);
        if ((dr > BigInt(0) && cr > BigInt(0)) || (dr === BigInt(0) && cr === BigInt(0))) {
          throw new Error(`السطر ${idx + 1}: أدخل مبلغاً في المدين أو الدائن فقط`);
        }
        const cur = totals.get(l.currency) ?? { dr: BigInt(0), cr: BigInt(0) };
        cur.dr += dr;
        cur.cr += cr;
        totals.set(l.currency, cur);
        return {
          [schema.lineKeys.account]: l.account_id,
          [schema.lineKeys.currency]: l.currency,
          [schema.lineKeys.debit]: Number(dr),
          [schema.lineKeys.credit]: Number(cr),
        };
      });

      if (rpcLines.length < 2) throw new Error("يجب أن يحتوي القيد على سطرين على الأقل");
      for (const [curr, sum] of totals.entries()) {
        if (sum.dr !== sum.cr) {
          throw new Error(`القيد غير متوازن لعملة ${curr} (مدين ${formatMinor(sum.dr, decimalsOf(curr))} ≠ دائن ${formatMinor(sum.cr, decimalsOf(curr))})`);
        }
      }

      setBusy(true);
      const { error } = await supabase.rpc("post_journal_entry", {
        p_org: activeOrgId,
        p_branch: jeBranch,
        p_date: jeDate,
        p_memo: jeMemo.trim() || "قيد يومية",
        p_key: crypto.randomUUID(),
        p_lines: rpcLines,
      });
      setBusy(false);
      if (error) return notify("err", error.message);
      setJeMemo("");
      setJeLines([
        { account_id: "", currency: activeOrg?.base_currency ?? "USD", debit: "", credit: "" },
        { account_id: "", currency: activeOrg?.base_currency ?? "USD", debit: "", credit: "" },
      ]);
      notify("ok", "تم ترحيل القيد المحاسبي بنجاح");
      loadOrgData(activeOrgId);
    } catch (err) {
      notify("err", err instanceof Error ? err.message : "خطأ غير متوقع");
    }
  }

  async function handleReverse(entryId: string) {
    setBusy(true);
    setMsg(null);
    const { error } = await supabase.rpc("reverse_journal_entry", {
      p_entry: entryId,
      p_key: crypto.randomUUID(),
      p_memo: "قيد عكسي",
      p_date: todayISO(),
    });
    setBusy(false);
    if (error) return notify("err", error.message);
    notify("ok", "تم إنشاء القيد العكسي بنجاح");
    loadOrgData(activeOrgId);
  }

  async function handleCloseBooks(e: React.FormEvent) {
    e.preventDefault();
    if (!activeOrgId) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("close_books", {
      p_org: activeOrgId,
      p_through: closeDate,
    });
    setBusy(false);
    if (error) return notify("err", error.message);
    notify("ok", `تم إقفال الفترة المحاسبية حتى تاريخ ${data ?? closeDate}`);
    loadOrgData(activeOrgId);
  }

  async function handleRedeem(e: React.FormEvent) {
    e.preventDefault();
    if (!activeOrgId || !actCode.trim()) return;
    setBusy(true);
    const { data, error } = await supabase.rpc("redeem_activation_code", {
      p_org: activeOrgId,
      p_code: actCode.trim(),
    });
    setBusy(false);
    if (error) return notify("err", error.message);
    if (!data) return notify("err", "رمز التفعيل غير صالح أو مستخدم مسبقاً");
    setActCode("");
    notify("ok", `تم تفعيل الاشتراك بنجاح حتى ${new Date(data).toLocaleDateString("ar")}`);
  }

  // Compute account balances per currency
  const balancesByAcc = new Map<string, Map<string, bigint>>();
  for (const l of lines) {
    const accMap = balancesByAcc.get(l.account_id) ?? new Map<string, bigint>();
    const prev = accMap.get(l.currency) ?? BigInt(0);
    accMap.set(l.currency, prev + BigInt(l.debit || 0) - BigInt(l.credit || 0));
    balancesByAcc.set(l.account_id, accMap);
  }

  const reversedIds = new Set(entries.map((e) => e.reverses_entry_id).filter(Boolean));

  if (!isSupabaseConfigured) {
    return (
      <main className="max-w-lg mx-auto p-6 mt-12 bg-slate-900 border border-rose-500/40 rounded-2xl">
        <h1 className="text-xl font-bold text-rose-400 mb-2">ملف الربط غير مهيأ</h1>
        <p className="text-sm text-slate-300">أضف متغيرات NEXT_PUBLIC_SUPABASE_URL و NEXT_PUBLIC_SUPABASE_ANON_KEY داخل web/.env.local ثم أعد تشغيل الخادم.</p>
      </main>
    );
  }

  if (authLoading) {
    return <main className="min-h-screen flex items-center justify-center text-slate-400">جاري التحميل...</main>;
  }

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-11 h-11 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
              <Building2 className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold">Sama Business</h1>
              <p className="text-xs text-slate-400">نظام المحاسبة السحابي الآمن</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 mb-5 bg-slate-950 p-1 rounded-xl">
            <button
              type="button"
              onClick={() => setAuthMode("login")}
              className={`py-2 rounded-lg text-sm font-medium ${authMode === "login" ? "bg-emerald-600 text-white" : "text-slate-400"}`}
            >
              تسجيل الدخول
            </button>
            <button
              type="button"
              onClick={() => setAuthMode("signup")}
              className={`py-2 rounded-lg text-sm font-medium ${authMode === "signup" ? "bg-emerald-600 text-white" : "text-slate-400"}`}
            >
              حساب جديد
            </button>
          </div>

          {msg && (
            <div className={`mb-4 p-3 rounded-xl text-sm flex gap-2 ${msg.type === "err" ? "bg-rose-950/70 text-rose-300 border border-rose-500/30" : "bg-emerald-950/70 text-emerald-300 border border-emerald-500/30"}`}>
              {msg.type === "err" ? <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
              <span>{msg.text}</span>
            </div>
          )}

          <form onSubmit={handleAuth} className="space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">البريد الإلكتروني</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@example.com"
                dir="ltr"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">كلمة المرور</label>
              <input
                type="password"
                required
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                dir="ltr"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:border-emerald-500"
              />
            </div>
            <button
              disabled={busy}
              className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl text-sm transition"
            >
              {busy ? "جاري التنفيذ..." : authMode === "login" ? "دخول إلى النظام" : "إنشاء الحساب"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-4 pb-16 space-y-5">
      {/* Header */}
      <header className="bg-slate-900 border border-slate-800 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
            <Building2 className="w-5 h-5" />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">Sama Business</h1>
            <p className="text-xs text-slate-400">{user.email}</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {orgs.length > 0 && (
            <select
              value={activeOrgId}
              onChange={(e) => setActiveOrgId(e.target.value)}
              className="bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-sm"
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.base_currency})
                </option>
              ))}
            </select>
          )}
          <button
            onClick={() => (activeOrgId ? loadOrgData(activeOrgId) : loadBase())}
            className="p-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-slate-300"
            title="تحديث"
          >
            <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={() => supabase.auth.signOut()}
            className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-rose-900/60 text-slate-200 rounded-xl text-xs"
          >
            <LogOut className="w-4 h-4" />
            خروج
          </button>
        </div>
      </header>

      {msg && (
        <div className={`p-3.5 rounded-xl text-sm flex items-start gap-2 ${msg.type === "err" ? "bg-rose-950/70 text-rose-300 border border-rose-500/30" : "bg-emerald-950/70 text-emerald-300 border border-emerald-500/30"}`}>
          {msg.type === "err" ? <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> : <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}

      {/* No org yet */}
      {orgs.length === 0 ? (
        <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-lg mx-auto">
          <h2 className="text-lg font-bold mb-1">إنشاء أول شركة / منشأة</h2>
          <p className="text-xs text-slate-400 mb-4">سيتم تأسيس شركتك وتعيينك مالكاً لها تلقائياً في قاعدة البيانات.</p>
          <form onSubmit={handleCreateOrg} className="space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">اسم المنشأة</label>
              <input
                required
                value={newOrgName}
                onChange={(e) => setNewOrgName(e.target.value)}
                placeholder="مثال: مركز هواوي للاتصالات"
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">العملة الأساسية</label>
              <select
                value={newOrgCurr}
                onChange={(e) => setNewOrgCurr(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-sm"
              >
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>{c.code}</option>
                ))}
              </select>
            </div>
            <button disabled={busy} className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-2.5 rounded-xl font-semibold text-sm">
              إنشاء الشركة والبدء
            </button>
          </form>
        </section>
      ) : (
        <>
          {/* Navigation Tabs */}
          <nav className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { id: "overview", label: "نظرة عامة", icon: Building2 },
              { id: "accounts", label: "الحسابات والصناديق", icon: Wallet },
              { id: "journal", label: "القيود اليومية", icon: BookOpen },
              { id: "controls", label: "الضوابط والتدقيق", icon: ShieldCheck },
            ].map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id as typeof tab)}
                  className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl text-sm font-medium border transition ${
                    active
                      ? "bg-emerald-600/20 border-emerald-500 text-emerald-300"
                      : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* TAB 1: OVERVIEW */}
          {tab === "overview" && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "الفروع", val: branches.length },
                  { label: "الحسابات", val: accounts.length },
                  { label: "الصناديق", val: cashboxes.length },
                  { label: "القيود المرحّلة", val: entries.length },
                ].map((c) => (
                  <div key={c.label} className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                    <p className="text-xs text-slate-400">{c.label}</p>
                    <p className="text-2xl font-bold mt-1 text-emerald-400">{c.val}</p>
                  </div>
                ))}
              </div>

              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4">
                <h2 className="font-bold text-sm mb-3">ميزان المراجعة السريع (أرصدة الحسابات)</h2>
                {accounts.length === 0 ? (
                  <p className="text-xs text-slate-400">لا توجد حسابات بعد. انتقل إلى تبويب «الحسابات والصناديق» لإضافتها.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-slate-400 border-b border-slate-800">
                        <tr>
                          <th className="py-2 text-right">الرمز</th>
                          <th className="py-2 text-right">الحساب</th>
                          <th className="py-2 text-right">النوع</th>
                          <th className="py-2 text-right">الرصيد (مدين − دائن)</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/70">
                        {accounts.map((a) => {
                          const map = balancesByAcc.get(a.id);
                          return (
                            <tr key={a.id}>
                              <td className="py-2 font-mono text-xs text-slate-400">{a.code}</td>
                              <td className="py-2 font-medium">{a.name}</td>
                              <td className="py-2 text-xs text-slate-400">{ACC_TYPE_AR[a.type] ?? a.type}</td>
                              <td className="py-2 font-mono text-xs">
                                {!map || map.size === 0
                                  ? "0"
                                  : [...map.entries()].map(([curr, bal]) => (
                                      <span key={curr} className="inline-block ml-2 px-2 py-0.5 rounded bg-slate-800">
                                        {formatMinor(bal, decimalsOf(curr))} {curr}
                                      </span>
                                    ))}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: ACCOUNTS & CASHBOXES */}
          {tab === "accounts" && (
            <div className="grid md:grid-cols-2 gap-4">
              {/* Branches */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <h2 className="font-bold text-sm">الفروع ({branches.length})</h2>
                <form onSubmit={handleAddBranch} className="flex gap-2">
                  <input
                    required
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    placeholder="اسم الفرع (مثلاً: الفرع الرئيسي)"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm"
                  />
                  <button className="bg-emerald-600 hover:bg-emerald-500 px-3 py-2 rounded-xl text-sm">إضافة</button>
                </form>
                <ul className="space-y-1.5 text-sm">
                  {branches.map((b) => (
                    <li key={b.id} className="bg-slate-950 px-3 py-2 rounded-xl border border-slate-800/80">{b.name}</li>
                  ))}
                </ul>
              </div>

              {/* Add Account */}
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <h2 className="font-bold text-sm">إضافة حساب محاسبي جديد</h2>
                <form onSubmit={handleAddAccount} className="space-y-2.5">
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      required
                      value={accCode}
                      onChange={(e) => setAccCode(e.target.value)}
                      placeholder="الرمز (1010)"
                      className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm"
                    />
                    <input
                      required
                      value={accName}
                      onChange={(e) => setAccName(e.target.value)}
                      placeholder="اسم الحساب (الصندوق الرئيسي)"
                      className="col-span-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm"
                    />
                  </div>
                  <div className="flex gap-2">
                    <select
                      value={accType}
                      onChange={(e) => setAccType(e.target.value)}
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm"
                    >
                      {schema.accountTypes.map((t) => (
                        <option key={t} value={t}>{ACC_TYPE_AR[t] ?? t} ({t})</option>
                      ))}
                    </select>
                    <button className="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl text-sm">حفظ</button>
                  </div>
                </form>
              </div>

              {/* Cashboxes */}
              <div className="md:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <h2 className="font-bold text-sm">الصناديق ({cashboxes.length})</h2>
                <form onSubmit={handleAddCashbox} className="grid sm:grid-cols-5 gap-2">
                  <input
                    required
                    value={cbName}
                    onChange={(e) => setCbName(e.target.value)}
                    placeholder="اسم الصندوق"
                    className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm"
                  />
                  <select value={cbBranch} onChange={(e) => setCbBranch(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm">
                    <option value="">اختر الفرع</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  <select value={cbAccount} onChange={(e) => setCbAccount(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm">
                    <option value="">حساب الصندوق (أصول)</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                  </select>
                  <select value={cbCurr} onChange={(e) => setCbCurr(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm">
                    {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                  </select>
                  <button className="bg-emerald-600 hover:bg-emerald-500 py-2 rounded-xl text-sm">إضافة صندوق</button>
                </form>
                <div className="grid sm:grid-cols-3 gap-2">
                  {cashboxes.map((cb) => (
                    <div key={cb.id} className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-sm">
                      <p className="font-semibold">{cb.name}</p>
                      <p className="text-xs text-slate-400">العملة: {cb.currency}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: JOURNAL ENTRIES */}
          {tab === "journal" && (
            <div className="space-y-4">
              <form onSubmit={handlePostJournal} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-4">
                <h2 className="font-bold text-sm">ترحيل قيد يومية جديد (قيد مزدوج متوازن)</h2>
                <div className="grid sm:grid-cols-3 gap-2">
                  <select value={jeBranch} onChange={(e) => setJeBranch(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm">
                    <option value="">اختر الفرع</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                  <input type="date" value={jeDate} onChange={(e) => setJeDate(e.target.value)} className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm" />
                  <input value={jeMemo} onChange={(e) => setJeMemo(e.target.value)} placeholder="البيان / الوصف" className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm" />
                </div>

                <div className="space-y-2">
                  {jeLines.map((line, i) => (
                    <div key={i} className="grid grid-cols-2 sm:grid-cols-12 gap-2 bg-slate-950 p-2.5 rounded-xl border border-slate-800">
                      <select
                        value={line.account_id}
                        onChange={(e) => setJeLines((ls) => ls.map((x, idx) => idx === i ? { ...x, account_id: e.target.value } : x))}
                        className="col-span-2 sm:col-span-5 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs"
                      >
                        <option value="">اختر الحساب</option>
                        {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} - {a.name}</option>)}
                      </select>
                      <select
                        value={line.currency}
                        onChange={(e) => setJeLines((ls) => ls.map((x, idx) => idx === i ? { ...x, currency: e.target.value } : x))}
                        className="sm:col-span-2 bg-slate-900 border border-slate-700 rounded-lg px-2 py-2 text-xs"
                      >
                        {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                      </select>
                      <input
                        placeholder="مدين"
                        value={line.debit}
                        onChange={(e) => setJeLines((ls) => ls.map((x, idx) => idx === i ? { ...x, debit: e.target.value, credit: "" } : x))}
                        className="sm:col-span-2 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs"
                      />
                      <input
                        placeholder="دائن"
                        value={line.credit}
                        onChange={(e) => setJeLines((ls) => ls.map((x, idx) => idx === i ? { ...x, credit: e.target.value, debit: "" } : x))}
                        className="sm:col-span-2 bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-2 text-xs"
                      />
                      <button
                        type="button"
                        disabled={jeLines.length <= 2}
                        onClick={() => setJeLines((ls) => ls.filter((_, idx) => idx !== i))}
                        className="col-span-2 sm:col-span-1 text-rose-400 disabled:opacity-30 text-xs"
                      >
                        حذف
                      </button>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setJeLines((ls) => [...ls, { account_id: "", currency: activeOrg?.base_currency ?? "USD", debit: "", credit: "" }])}
                    className="flex items-center gap-1 px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl text-xs"
                  >
                    <Plus className="w-4 h-4" /> سطر إضافي
                  </button>
                  <button disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 px-5 py-2 rounded-xl text-sm font-semibold">
                    ترحيل القيد الآن
                  </button>
                </div>
              </form>

              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <h2 className="font-bold text-sm">سجل القيود المرحّلة ({entries.length})</h2>
                {entries.length === 0 ? (
                  <p className="text-xs text-slate-400">لم تُسجّل أي قيود بعد.</p>
                ) : (
                  <div className="space-y-3">
                    {entries.map((en) => {
                      const enLines = lines.filter((l) => l.entry_id === en.id);
                      const isReversed = reversedIds.has(en.id) || Boolean(en.reverses_entry_id);
                      return (
                        <div key={en.id} className="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="text-xs font-mono text-emerald-400 ml-2">{en.entry_date}</span>
                              <span className="text-sm font-semibold">{en.memo || "قيد يومية"}</span>
                              {en.reverses_entry_id && (
                                <span className="mr-2 text-[11px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded">قيد عكسي</span>
                              )}
                            </div>
                            {!isReversed && (
                              <button
                                onClick={() => handleReverse(en.id)}
                                disabled={busy}
                                className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 rounded-lg"
                              >
                                <RotateCcw className="w-3.5 h-3.5" /> عكس القيد
                              </button>
                            )}
                          </div>
                          <div className="text-xs text-slate-300 space-y-1">
                            {enLines.map((l) => {
                              const acc = accounts.find((a) => a.id === l.account_id);
                              const dec = decimalsOf(l.currency);
                              return (
                                <div key={l.id} className="flex justify-between border-t border-slate-800/60 pt-1">
                                  <span>{acc ? `${acc.code} - ${acc.name}` : l.account_id}</span>
                                  <span className="font-mono">
                                    {Number(l.debit) > 0
                                      ? `مدين ${formatMinor(l.debit, dec)} ${l.currency}`
                                      : `دائن ${formatMinor(l.credit, dec)} ${l.currency}`}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: CONTROLS & AUDIT */}
          {tab === "controls" && (
            <div className="grid md:grid-cols-2 gap-4">
              <form onSubmit={handleCloseBooks} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <h2 className="font-bold text-sm flex items-center gap-2"><Lock className="w-4 h-4 text-amber-400" /> إقفال الفترة المحاسبية</h2>
                <p className="text-xs text-slate-400">يمنع ترحيل أو عكس أي قيد بتاريخ يساوي أو يسبق تاريخ الإقفال.</p>
                <div className="flex gap-2">
                  <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm" />
                  <button className="bg-amber-600 hover:bg-amber-500 px-4 py-2 rounded-xl text-sm font-semibold">إقفال</button>
                </div>
              </form>

              <form onSubmit={handleRedeem} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
                <h2 className="font-bold text-sm">تفعيل اشتراك عبر رمز التفعيل</h2>
                <div className="flex gap-2">
                  <input
                    value={actCode}
                    onChange={(e) => setActCode(e.target.value)}
                    placeholder="أدخل رمز التفعيل"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-sm"
                  />
                  <button className="bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl text-sm font-semibold">تفعيل</button>
                </div>
              </form>

              <div className="md:col-span-2 bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-2">
                <h2 className="font-bold text-sm">سجل التدقيق الأخير ({audits.length})</h2>
                {audits.length === 0 ? (
                  <p className="text-xs text-slate-400">لا توجد سجلات تدقيق بعد.</p>
                ) : (
                  <div className="space-y-1.5 text-xs">
                    {audits.map((au) => (
                      <div key={au.id} className="flex justify-between bg-slate-950 px-3 py-2 rounded-lg border border-slate-800">
                        <span>{au.entity} — <strong className="text-emerald-400">{au.action}</strong></span>
                        <span className="text-slate-400 font-mono">{new Date(au.at).toLocaleString("ar")}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
