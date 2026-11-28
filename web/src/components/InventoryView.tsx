"use client";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Package, Plus, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { formatMinor, parseMinor } from "@/lib/money";

type Currency = { code: string; decimals: number };
type Product = {
  id: string; sku: string; name: string; unit: string; currency: string;
  price_minor: string | number; cost_minor: string | number; tax_bp: number; track_stock: boolean;
};
type Props = {
  orgId: string; role: string | null; currencies: Currency[];
  notify: (type: "ok" | "err", text: string) => void;
};

const fmtQty = (q: string) => formatMinor(q, 3).replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1");

export function InventoryView({ orgId, role, currencies, notify }: Props) {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [busy, setBusy] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [stock, setStock] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("قطعة");
  const [curr, setCurr] = useState(currencies[0]?.code ?? "USD");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [tax, setTax] = useState("0");
  const [track, setTrack] = useState(true);

  const decOf = (c: string) => currencies.find((x) => x.code === c)?.decimals ?? 2;
  const canEdit = role ? ["owner", "admin", "accountant"].includes(role) : false;

  const load = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    const [pRes, sRes] = await Promise.all([
      supabase.from("products").select("*").eq("org_id", orgId).order("name"),
      supabase.from("v_stock_on_hand").select("product_id,qty_milli").eq("org_id", orgId),
    ]);
    if (pRes.error) notifyRef.current("err", `تعذر تحميل المنتجات: ${pRes.error.message}`);
    setProducts((pRes.data as Product[]) ?? []);
    const sm: Record<string, string> = {};
    for (const r of (sRes.data as Array<{ product_id: string; qty_milli: string }> | null) ?? []) sm[r.product_id] = r.qty_milli;
    setStock(sm);
    setBusy(false);
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (currencies[0] && !currencies.some((c) => c.code === curr)) setCurr(currencies[0].code); }, [currencies, curr]);

  async function addProduct(e: FormEvent) {
    e.preventDefault();
    try {
      const d = decOf(curr);
      const tPct = Number(tax.trim() || "0");
      if (!Number.isFinite(tPct) || tPct < 0 || tPct > 100) throw new Error("الضريبة بين 0 و 100");
      setBusy(true);
      const { error } = await supabase.from("products").insert({
        org_id: orgId, sku: sku.trim(), name: name.trim(), unit: unit.trim() || "قطعة",
        currency: curr, price_minor: parseMinor(price || "0", d).toString(),
        cost_minor: parseMinor(cost || "0", d).toString(), tax_bp: Math.round(tPct * 100), track_stock: track,
      });
      setBusy(false);
      if (error) return notifyRef.current("err", `تعذر إضافة المنتج: ${error.message}`);
      setSku(""); setName(""); setPrice(""); setCost(""); setTax("0");
      notifyRef.current("ok", "تمت إضافة المنتج بنجاح ✓");
      void load();
    } catch (ex) { notifyRef.current("err", ex instanceof Error ? ex.message : "بيانات غير صالحة"); }
  }

  const list = products.filter((p) => !search.trim() || p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-base flex items-center gap-2"><Package className="w-5 h-5" /> المنتجات والمخزون</h2>
        <button type="button" onClick={() => void load()} className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 rounded-xl text-xs">
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} /> تحديث
        </button>
      </div>
      {canEdit && (
        <form onSubmit={addProduct} className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3">
          <h3 className="font-bold text-sm">إضافة منتج جديد</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            <input required value={sku} onChange={(e) => setSku(e.target.value)} placeholder="الرمز SKU" className="px-3 py-2 text-sm border" />
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم الصنف" className="px-3 py-2 text-sm border" />
            <input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="الوحدة (قطعة)" className="px-3 py-2 text-sm border" />
            <select value={curr} onChange={(e) => setCurr(e.target.value)} className="px-3 py-2 text-sm border">{currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select>
            <input required value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="سعر البيع" className="px-3 py-2 text-sm border" />
            <input value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" placeholder="التكلفة / الجملة" className="px-3 py-2 text-sm border" />
            <input value={tax} onChange={(e) => setTax(e.target.value)} inputMode="decimal" placeholder="الضريبة %" className="px-3 py-2 text-sm border" />
            <label className="flex items-center gap-2 text-xs px-2"><input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} /> تتبع المخزون</label>
            <button disabled={busy} className="bg-emerald-600 text-white py-2 px-4 rounded-xl text-sm font-semibold flex items-center justify-center gap-1.5"><Plus className="w-4 h-4" /> حفظ</button>
          </div>
        </form>
      )}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-3 overflow-x-auto">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-bold text-sm">الأصناف المتوفرة ({list.length})</h3>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث..." className="px-3 py-1.5 text-xs border w-48" />
        </div>
        <table className="w-full text-xs">
          <thead className="border-b border-slate-800 text-slate-400">
            <tr><th className="py-2 text-start">الرمز</th><th className="py-2 text-start">الصنف</th><th className="py-2 text-end">البيع</th><th className="py-2 text-end">التكلفة</th><th className="py-2 text-end">الرصيد</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {list.map((p) => {
              const d = decOf(p.currency);
              return (
                <tr key={p.id}>
                  <td className="py-2 font-mono">{p.sku}</td><td className="py-2 font-medium">{p.name}</td>
                  <td className="py-2 text-end font-semibold">{formatMinor(p.price_minor, d)} {p.currency}</td>
                  <td className="py-2 text-end">{formatMinor(p.cost_minor, d)}</td>
                  <td className="py-2 text-end font-bold">{p.track_stock ? `${fmtQty(stock[p.id] ?? "0")} ${p.unit}` : "خدمة"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {list.length === 0 && <p className="text-xs text-slate-400 py-2">لا توجد أصناف بعد — أضف أول صنف ثم أدخل كميته من «المشتريات».</p>}
      </div>
    </div>
  );
}
