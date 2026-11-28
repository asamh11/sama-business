"use client";
import { useEffect, useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";

export function RoyalStatusStrip() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("sama_hide_balances") === "1";
      setHidden(saved);
      document.body.classList.toggle("sama-privacy-on", saved);
    } catch {}
  }, []);

  function toggle() {
    const next = !hidden;
    setHidden(next);
    document.body.classList.toggle("sama-privacy-on", next);
    try { window.localStorage.setItem("sama_hide_balances", next ? "1" : "0"); } catch {}
  }

  return (
    <div className="mb-3 px-3.5 py-2 rounded-2xl bg-white border border-[#E4EAF2] flex flex-wrap items-center justify-between gap-2 text-xs shadow-xs">
      <div className="flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full bg-[#C5A46D]" />
        <span className="font-bold text-[#152743]">Sama Business</span>
        <span className="text-[#68778D] hidden sm:inline">• Royal Enterprise × Smart Intelligence</span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#ECFDF3] text-[#15803D] font-semibold">
          <ShieldCheck className="w-3.5 h-3.5" /> BigInt 100%
        </span>
      </div>
      <button
        type="button"
        onClick={toggle}
        className="px-3 py-1.5 rounded-xl bg-[#F7F9FC] hover:bg-[#EDF2F8] border border-[#E4EAF2] text-[#152743] font-semibold inline-flex items-center gap-1.5"
      >
        {hidden ? <Eye className="w-3.5 h-3.5 text-[#2869DB]" /> : <EyeOff className="w-3.5 h-3.5 text-[#68778D]" />}
        <span>{hidden ? "إظهار الأرصدة" : "إخفاء الأرصدة"}</span>
      </button>
    </div>
  );
}
