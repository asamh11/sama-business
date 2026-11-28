"use client";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownLeft, ArrowUpRight, BarChart3, Eye, EyeOff,
  PackagePlus, RefreshCw, ShieldCheck, ShoppingCart,
  Sparkles, TrendingUp, Wallet
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatMinor } from "@/lib/money";

type Currency = { code: string; decimals: number };
type StoreFin = {
  currency: string; revenue: string; expense: string; net_profit: string;
  cash: string; inventory_value: string; receivables: string; imbalance: string;
};
type ExecData = { store_financials?: StoreFin[] };
type AuditData = { score?: number; overall_status?: string };

type Props = {
  orgId: string;
  orgName: string;
  baseCurrency: string;
  currencies: Currency[];
  branchesCount: number;
  accountsCount: number;
  onNavigate: (sec: string) => void;
};

const ZERO = BigInt(0);

export function RoyalHomeDashboard({
  orgId, orgName, baseCurrency, currencies, branchesCount, accountsCount, onNavigate,
}: Props) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fin, setFin] = useState<StoreFin | null>(null);
  const [healthScore, setHealthScore] = useState<number>(100);

  const decOf = (c: string) => currencies.find((x) => x.code === c)?.decimals ?? 2;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("sama_hide_balances") === "1";
      setHidden(saved);
      document.body.classList.toggle("sama-privacy-on", saved);
    } catch {}
  }, []);

  const loadHero = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    const [eRes, aRes] = await Promise.all([
      supabase.rpc("get_executive_dashboard", { p_org: orgId, p_stagnant_days: 30 }),
      supabase.rpc("run_background_system_audit", { p_org: orgId }),
    ]);
    const list = ((eRes.data as ExecData | null)?.store_financials) ?? [];
    const primary = list.find((x) => x.currency === baseCurrency) ?? list[0] ?? null;
    setFin(primary);
    const sc = (aRes.data as AuditData | null)?.score;
    if (typeof sc === "number") setHealthScore(sc);
    setBusy(false);
  }, [orgId, baseCurrency]);

  useEffect(() => { void loadHero(); }, [loadHero]);

  function togglePrivacy() {
    const next = !hidden;
    setHidden(next);
    document.body.classList.toggle("sama-privacy-on", next);
    try { window.localStorage.setItem("sama_hide_balances", next ? "1" : "0"); } catch {}
  }

  const curr = fin?.currency ?? baseCurrency ?? "USD";
  const d = decOf(curr);
  const cashVal = fin ? formatMinor(fin.cash, d) : formatMinor(ZERO, d);
  const revVal = fin ? formatMinor(fin.revenue, d) : formatMinor(ZERO, d);
  const expVal = fin ? formatMinor(fin.expense, d) : formatMinor(ZERO, d);
  const netVal = fin ? formatMinor(fin.net_profit, d) : formatMinor(ZERO, d);
  const invVal = fin ? formatMinor(fin.inventory_value, d) : formatMinor(ZERO, d);
  const recVal = fin ? formatMinor(fin.receivables, d) : formatMinor(ZERO, d);
  const balanced = !fin || BigInt(fin.imbalance) === ZERO;
  const blurCls = hidden ? "blur-md select-none" : "";

  return (
    <div className="space-y-4 mb-5">
      {/* 1. البطاقة المالية الملكية الرئيسية (Deep Navy #152743 -> Royal Blue #2869DB + Gold #C5A46D) */}
      <div className="sama-royal-hero rounded-2xl p-5 text-white space-y-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs opacity-90">
              <Wallet className="w-4 h-4 text-[#C5A46D] shrink-0" />
              <span className="truncate">رصيد الصندوق الرئيسي — {orgName || "منشأتك"}</span>
            </div>
            <div className={`text-3xl font-bold mt-1.5 tracking-tight ${blurCls}`} dir="ltr">
              {cashVal} <span className="text-base font-semibold opacity-80">{curr}</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={togglePrivacy}
              className="sama-hero-btn p-2 rounded-xl"
              title={hidden ? "إظهار الأرصدة" : "إخفاء الأرصدة"}
            >
              {hidden ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => void loadHero()}
              className="sama-hero-btn p-2 rounded-xl"
              title="تحديث الأرصدة"
            >
              <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        <div className="h-[2px] w-full bg-gradient-to-r from-transparent via-[#C5A46D] to-transparent opacity-70" />

        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate("inventory")}
            className="sama-hero-subbox text-start p-3 rounded-xl"
          >
            <div className="text-xs opacity-80">قيمة المخزون</div>
            <div className={`font-bold text-base mt-0.5 ${blurCls}`} dir="ltr">{invVal} {curr}</div>
          </button>
          <button
            type="button"
            onClick={() => onNavigate("contacts")}
            className="sama-hero-subbox text-start p-3 rounded-xl"
          >
            <div className="text-xs opacity-80">ذمم وديون العملاء</div>
            <div className={`font-bold text-base mt-0.5 ${blurCls}`} dir="ltr">{recVal} {curr}</div>
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs pt-1 opacity-90">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <ShieldCheck className="w-4 h-4 text-[#C5A46D]" />
            {balanced ? "الميزان متوازن 100% (BigInt)" : "يوجد فرق توازن"} • جاهزية {healthScore}/100
          </span>
          <span>فروع: {branchesCount} • حسابات: {accountsCount}</span>
        </div>
      </div>

      {/* 2. ملخص النشاط (3 بطاقات نقية قابلة للضغط للتتبع المحاسبي) */}
      <div className="grid grid-cols-3 gap-2.5">
        <button
          type="button"
          onClick={() => onNavigate("sales")}
          className="sama-kpi-card p-3.5 text-start space-y-1.5"
        >
          <div className="text-xs text-[#68778D] font-semibold">المبيعات</div>
          <div className={`font-bold text-base text-[#152743] truncate ${blurCls}`} dir="ltr">{revVal}</div>
          <div className="text-[11px] font-bold text-[#2869DB]">{curr}</div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("accounting")}
          className="sama-kpi-card p-3.5 text-start space-y-1.5"
        >
          <div className="text-xs text-[#68778D] font-semibold">المصروفات</div>
          <div className={`font-bold text-base text-[#C2410C] truncate ${blurCls}`} dir="ltr">{expVal}</div>
          <div className="text-[11px] font-bold text-[#68778D]">{curr}</div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate("reports")}
          className="sama-kpi-card p-3.5 text-start space-y-1.5"
        >
          <div className="text-xs text-[#68778D] font-semibold flex items-center gap-1">
            <TrendingUp className="w-3.5 h-3.5 text-[#15803D]" /> الربح
          </div>
          <div className={`font-bold text-base text-[#15803D] truncate ${blurCls}`} dir="ltr">{netVal}</div>
          <div className="text-[11px] font-bold text-[#15803D]">التتبع ←</div>
        </button>
      </div>

      {/* 3. العمليات السريعة الأربع (بيع / شراء / قبض / صرف) */}
      <div className="sama-kpi-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-sm text-[#152743]">العمليات السريعة</h3>
          <button
            type="button"
            onClick={() => onNavigate("ai")}
            className="text-xs font-bold text-[#2869DB] inline-flex items-center gap-1"
          >
            <Sparkles className="w-3.5 h-3.5" /> المستشار الذكي
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <button
            type="button"
            onClick={() => onNavigate("sales")}
            className="sama-quick-primary py-3 px-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
          >
            <ShoppingCart className="w-4 h-4" /> بيع (POS)
          </button>
          <button
            type="button"
            onClick={() => onNavigate("purchases")}
            className="sama-quick-soft py-3 px-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
          >
            <PackagePlus className="w-4 h-4 text-[#2869DB]" /> شراء
          </button>
          <button
            type="button"
            onClick={() => onNavigate("contacts")}
            className="sama-quick-soft py-3 px-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
          >
            <ArrowDownLeft className="w-4 h-4 text-[#15803D]" /> قبض / ديون
          </button>
          <button
            type="button"
            onClick={() => onNavigate("reports")}
            className="sama-quick-soft py-3 px-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2"
          >
            <ArrowUpRight className="w-4 h-4 text-[#C2410C]" /> تقارير وقياس
          </button>
        </div>
      </div>

      {/* اختصار سريع لمركز التقارير الكاملة */}
      <button
        type="button"
        onClick={() => onNavigate("reports")}
        className="w-full sama-kpi-card p-3.5 flex items-center justify-between text-xs font-bold text-[#152743]"
      >
        <span className="inline-flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-[#2869DB]" />
          فتح مقياس الإجراءات، المقارنة الشهرية، الأكثر مبيعاً، وحركة الموظفين
        </span>
        <span className="text-[#2869DB]">عرض ←</span>
      </button>
    </div>
  );
}
