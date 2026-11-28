"use client";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Camera, Loader2, Plus, Printer, RefreshCw, Save, ScanLine, Send, Settings2, ShoppingCart, Sparkles, Trash2, X, Zap } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { invokeAiOcr } from "@/lib/aiBrain";
import { computeInvoice } from "@/lib/invoice";
import { formatMinor, parseMinor } from "@/lib/money";

type Branch = { id: string; name: string };
type Account = { id: string; code: string; name: string; type: string };
type Currency = { code: string; decimals: number };
type Product = { id: string; sku: string; name: string; unit?: string; currency: string; price_minor: string | number; cost_minor: string | number; tax_bp: number; track_stock?: boolean };
type ContactBrief = { id: string; name: string; currency: string; balance_minor: string | number; credit_limit_minor?: string | number };
type Invoice = { id: string; kind: "sales" | "purchase"; number: string; party_name: string | null; currency: string; issue_date: string; due_date?: string | null; status: string; total_minor: string | number; paid_minor?: string | number; verification_code?: string | null };
type Cfg = { receivable_account_id: string; sales_account_id: string; tax_account_id: string; inventory_account_id: string; cogs_account_id: string; payable_account_id: string };
type DraftLine = { productId: string; itemQuery: string; qty: string; unitPrice: string; discPct: string; taxPct: string };
type PayMode = "cash" | "partial" | "credit";
type Props = {
  kind: "sales" | "purchase"; orgId: string; userId: string; role: string | null;
  branches: Branch[]; accounts: Account[]; currencies: Currency[];
  notify: (type: "ok" | "err", text: string) => void;
  askConfirm: (title: string, msg: string, run: () => void) => void;
  onPosted: () => void;
};

const ZERO = BigInt(0);
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const pctBp = (v: string) => { const n = Number(v.trim() || "0"); if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("النسبة بين 0 و 100"); return Math.round(n * 100); };
const fmtQty = (q: string) => formatMinor(q, 3).replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1");

export function InvoicesView({ kind, orgId, userId, role, branches, accounts, currencies, notify, askConfirm, onPosted }: Props) {
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const [busy, setBusy] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [habits, setHabits] = useState<Product[]>([]);
  const [topCustomers, setTopCustomers] = useState<string[]>([]);
  const [contacts, setContacts] = useState<ContactBrief[]>([]);
  const [stock, setStock] = useState<Record<string, string>>({});
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [printInv, setPrintInv] = useState<Invoice | null>(null);
  const [showCfg, setShowCfg] = useState(false);
  const [cfg, setCfg] = useState<Cfg>({ receivable_account_id: "", sales_account_id: "", tax_account_id: "", inventory_account_id: "", cogs_account_id: "", payable_account_id: "" });
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [curr, setCurr] = useState(currencies[0]?.code ?? "USD");
  const [num, setNum] = useState("");
  const [party, setParty] = useState("");
  const [contactId, setContactId] = useState("");
  const [payMode, setPayMode] = useState<PayMode>("cash");
  const [paidInput, setPaidInput] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO);
  const [dueDate, setDueDate] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([{ productId: "", itemQuery: "", qty: "1", unitPrice: "", discPct: "0", taxPct: "0" }]);
  const [barcodeInput, setBarcodeInput] = useState("");
  const [bcCamOpen, setBcCamOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const lastScanRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const productsRef = useRef<Product[]>(products);
  productsRef.current = products;
  const didAutoCurr = useRef(false);

  const decOf = useCallback((c: string) => currencies.find((x) => x.code === c)?.decimals ?? 2, [currencies]);
  const canWrite = role ? (kind === "purchase" ? ["owner", "admin", "accountant"].includes(role) : ["owner", "admin", "accountant", "cashier"].includes(role)) : false;
  const canCfg = role ? ["owner", "admin"].includes(role) : false;

  const stopBcCam = useCallback(() => {
    window.cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setBcCamOpen(false);
  }, []);

  useEffect(() => () => stopBcCam(), [stopBcCam]);

  const load = useCallback(async () => {
    if (!orgId) return;
    setBusy(true);
    const [pRes, sRes, iRes, cRes, hRes, ctRes] = await Promise.all([
      supabase.from("products").select("id,sku,name,unit,currency,price_minor,cost_minor,tax_bp,track_stock").eq("org_id", orgId).order("name"),
      supabase.from("v_stock_on_hand").select("product_id,qty_milli").eq("org_id", orgId),
      supabase.from("invoices").select("id,kind,number,party_name,currency,issue_date,due_date,status,total_minor,paid_minor,verification_code").eq("org_id", orgId).eq("kind", kind).order("created_at", { ascending: false }).limit(50),
      supabase.from("org_settings").select("*").eq("org_id", orgId).maybeSingle(),
      supabase.rpc("get_top_habits", { p_org: orgId, p_limit: 6 }),
      supabase.from("contacts").select("id,name,currency,balance_minor,credit_limit_minor").eq("org_id", orgId).order("name"),
    ]);
    if (iRes.error) notifyRef.current("err", `تعذر تحميل الفواتير: ${iRes.error.message}`);
    setProducts((pRes.data as Product[]) ?? []);
    const sm: Record<string, string> = {};
    for (const r of (sRes.data as Array<{ product_id: string; qty_milli: string }> | null) ?? []) sm[r.product_id] = r.qty_milli;
    setStock(sm);
    setInvoices((iRes.data as Invoice[]) ?? []);
    setContacts((ctRes.data as ContactBrief[]) ?? []);
    if (hRes.data) {
      const hd = hRes.data as { top_products?: Product[]; top_customers?: Array<{ name: string }>; preferred_currency?: string | null };
      setHabits(hd.top_products ?? []);
      setTopCustomers((hd.top_customers ?? []).map((x) => x.name));
      if (!didAutoCurr.current && hd.preferred_currency && currencies.some((c) => c.code === hd.preferred_currency)) {
        didAutoCurr.current = true;
        setCurr(hd.preferred_currency);
      }
    }
    if (cRes.data) {
      const d = cRes.data as Record<string, string | null>;
      setCfg({
        receivable_account_id: d.receivable_account_id ?? "", sales_account_id: d.sales_account_id ?? "",
        tax_account_id: d.tax_account_id ?? "", inventory_account_id: d.inventory_account_id ?? "",
        cogs_account_id: d.cogs_account_id ?? "", payable_account_id: d.payable_account_id ?? "",
      });
    }
    setBusy(false);
  }, [orgId, kind, currencies]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (!branchId && branches[0]) setBranchId(branches[0].id); }, [branches, branchId]);
  useEffect(() => { setNum(`${kind === "sales" ? "INV" : "PUR"}-${Date.now().toString().slice(-6)}`); }, [kind]);

  const addProductByBarcode = useCallback((raw: string) => {
    const code = raw.trim().toUpperCase();
    if (!code) return;
    const pr = productsRef.current.find((p) => p.sku.trim().toUpperCase() === code);
    if (!pr) {
      notifyRef.current("err", `الباركود (${code}) غير موجود بالمخزون — أضفه من «إدخال للمخزون بالباركود»`);
      return;
    }
    setCurr(pr.currency);
    const priceStr = formatMinor(kind === "purchase" ? pr.cost_minor : pr.price_minor, decOf(pr.currency)).replace(/,/g, "");
    setLines((prev) => {
      const existingIdx = prev.findIndex((l) => l.productId === pr.id);
      if (existingIdx >= 0) {
        return prev.map((l, idx) => idx !== existingIdx ? l : { ...l, qty: String((Number(l.qty) || 0) + 1) });
      }
      const emptyIdx = prev.findIndex((l) => !l.productId && !l.itemQuery.trim());
      const newLine: DraftLine = { productId: pr.id, itemQuery: pr.name, qty: "1", unitPrice: priceStr, discPct: "0", taxPct: String(pr.tax_bp / 100) };
      if (emptyIdx >= 0) return prev.map((l, idx) => (idx === emptyIdx ? newLine : l));
      return [...prev, newLine];
    });
    notifyRef.current("ok", `تم مسح «${pr.name}» وإضافته للفاتورة ✓`);
  }, [kind, decOf]);

  async function startInlineBarcodeCam() {
    if (bcCamOpen) { stopBcCam(); return; }
    if (!navigator.mediaDevices?.getUserMedia) return notifyRef.current("err", "الكاميرا غير مدعومة");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      streamRef.current = stream;
      setBcCamOpen(true);
      await new Promise((r) => window.setTimeout(r, 60));
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      type DetectorLike = { detect: (src: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
      const bw = window as unknown as { BarcodeDetector?: new () => DetectorLike };
      const detector = bw.BarcodeDetector ? new bw.BarcodeDetector() : null;
      if (!detector) { notifyRef.current("err", "المتصفح لا يدعم القراءة التلقائية للباركود — استخدم Chrome أو حقل الباركود اليدوي"); return; }
      let frame = 0;
      const loop = () => {
        const video = videoRef.current;
        if (!video || !streamRef.current) return;
        if (video.readyState >= 2 && frame % 12 === 0) {
          void detector.detect(video).then((codes) => {
            const val = codes[0]?.rawValue?.trim();
            if (!val) return;
            const now = Date.now();
            if (lastScanRef.current.code === val && now - lastScanRef.current.at < 1600) return;
            lastScanRef.current = { code: val, at: now };
            addProductByBarcode(val);
          }).catch(() => {});
        }
        frame++;
        rafRef.current = window.requestAnimationFrame(loop);
      };
      rafRef.current = window.requestAnimationFrame(loop);
    } catch {
      stopBcCam();
      notifyRef.current("err", "تعذر فتح الكاميرا — تأكد من إذن الكاميرا");
    }
  }

  // قراءة فاتورة بالكاميرا (OCR) لملء سطور فاتورة البيع أو الشراء مباشرةً
  function handleInvoiceOcrFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const b64 = String(reader.result ?? "").split(",")[1] ?? "";
      if (!b64) return;
      setOcrBusy(true);
      try {
        const res = await invokeAiOcr(orgId, b64, file.type || "image/jpeg");
        const r = res.result;
        if (r.party_name) setParty(r.party_name);
        if (r.issue_date) setIssueDate(r.issue_date);
        if (r.currency && currencies.some((c) => c.code === r.currency.toUpperCase())) setCurr(r.currency.toUpperCase());
        const items = r.items && r.items.length > 0
          ? r.items
          : [{ name: r.summary_ar || "بضاعة فاتورة", qty: "1", unit_price: r.total_amount }];
        setLines(items.map((it) => {
          const match = productsRef.current.find((p) => p.name.trim().toLowerCase() === it.name.trim().toLowerCase());
          return {
            productId: match?.id ?? "",
            itemQuery: it.name,
            qty: it.qty || "1",
            unitPrice: it.unit_price || "0",
            discPct: "0",
            taxPct: "0",
          };
        }));
        notifyRef.current("ok", `قرأ Gemini الفاتورة وملأ ${items.length} سطور تلقائياً — راجع واضغط «ترحيل» ✓`);
      } catch (ex) {
        notifyRef.current("err", `تعذر قراءة الفاتورة: ${ex instanceof Error ? ex.message : "خطأ"}`);
      } finally {
        setOcrBusy(false);
      }
    };
    reader.readAsDataURL(file);
  }
  async function saveCfg(e: FormEvent) {
    e.preventDefault(); setBusy(true);
    const { error } = await supabase.from("org_settings").upsert({
      org_id: orgId, receivable_account_id: cfg.receivable_account_id || null, sales_account_id: cfg.sales_account_id || null,
      tax_account_id: cfg.tax_account_id || null, inventory_account_id: cfg.inventory_account_id || null,
      cogs_account_id: cfg.cogs_account_id || null, payable_account_id: cfg.payable_account_id || null,
    }, { onConflict: "org_id" });
    setBusy(false);
    if (error) return notifyRef.current("err", `تعذر حفظ الربط: ${error.message}`);
    notifyRef.current("ok", "تم حفظ حسابات ربط الفواتير ✓"); setShowCfg(false);
  }

  const fillFromProduct = (pr: Product, idx: number) => {
    setLines((prev) => prev.map((l, i) => i !== idx ? l : {
      ...l, productId: pr.id, itemQuery: pr.name,
      unitPrice: formatMinor(kind === "purchase" ? pr.cost_minor : pr.price_minor, decOf(pr.currency)).replace(/,/g, ""),
      taxPct: String(pr.tax_bp / 100),
    }));
  };

  function applyHabitProduct(pr: Product) {
    if (pr.currency !== curr) setCurr(pr.currency);
    const emptyIdx = lines.findIndex((l) => !l.productId && !l.itemQuery.trim());
    const priceStr = formatMinor(kind === "purchase" ? pr.cost_minor : pr.price_minor, decOf(pr.currency)).replace(/,/g, "");
    if (emptyIdx >= 0) fillFromProduct(pr, emptyIdx);
    else setLines((p) => [...p, { productId: pr.id, itemQuery: pr.name, qty: "1", unitPrice: priceStr, discPct: "0", taxPct: String(pr.tax_bp / 100) }]);
  }

  const editLine = (i: number, patch: Partial<DraftLine>) => setLines((prev) => prev.map((l, idx) => {
    if (idx !== i) return l;
    const next = { ...l, ...patch };
    if (patch.itemQuery !== undefined) {
      const q = patch.itemQuery.trim().toLowerCase();
      const exact = products.find((p) => p.currency === curr && (p.name.toLowerCase() === q || p.sku.toLowerCase() === q));
      if (exact) {
        next.productId = exact.id;
        next.unitPrice = formatMinor(kind === "purchase" ? exact.cost_minor : exact.price_minor, decOf(exact.currency)).replace(/,/g, "");
        next.taxPct = String(exact.tax_bp / 100);
      } else {
        next.productId = "";
      }
    }
    return next;
  }));

  let totalPreview: bigint | null = null;
  try {
    const valid = lines.filter((l) => (l.productId || l.itemQuery.trim()) && l.qty.trim());
    if (valid.length) totalPreview = computeInvoice(valid.map((l) => ({
      qtyMilli: parseMinor(l.qty, 3), unitMinor: parseMinor(l.unitPrice || "0", decOf(curr)),
      discountBp: pctBp(l.discPct), taxBp: pctBp(l.taxPct),
    }))).total;
  } catch { totalPreview = null; }

  async function saveInvoice(andPost: boolean) {
    try {
      const d = decOf(curr);
      const activeLines = lines.filter((l) => l.productId || l.itemQuery.trim());
      if (!activeLines.length) return notifyRef.current("err", "أدخل اسم قطعة أو امسح باركوداً واحداً على الأقل");

      setBusy(true);
      const resolved: Array<{ product_id: string; qty_milli: bigint; unit_minor: bigint; discount_bp: number; tax_bp: number }> = [];
      for (const l of activeLines) {
        let pid = l.productId;
        const unitMinor = parseMinor(l.unitPrice || "0", d);
        if (!pid) {
          const { data: qp, error: qErr } = await supabase.rpc("upsert_quick_product", {
            p_org: orgId, p_name: l.itemQuery.trim(), p_currency: curr,
            p_price_minor: unitMinor.toString(), p_cost_minor: kind === "purchase" ? unitMinor.toString() : "0",
            p_track_stock: kind === "purchase",
          });
          if (qErr || !qp) { setBusy(false); return notifyRef.current("err", `تعذر حفظ الصنف الجديد: ${qErr?.message ?? ""}`); }
          pid = (qp as { id: string }).id;
        }
        resolved.push({
          product_id: pid, qty_milli: parseMinor(l.qty, 3), unit_minor: unitMinor,
          discount_bp: pctBp(l.discPct), tax_bp: pctBp(l.taxPct),
        });
      }

      const sum = computeInvoice(resolved.map((x) => ({ qtyMilli: x.qty_milli, unitMinor: x.unit_minor, discountBp: x.discount_bp, taxBp: x.tax_bp })));
      let paidMinor = sum.total;
      if (kind === "sales") {
        if (payMode === "credit") paidMinor = ZERO;
        if (payMode === "partial") paidMinor = parseMinor(paidInput || "0", d);
        if (paidMinor < ZERO || paidMinor > sum.total) { setBusy(false); return notifyRef.current("err", "المبلغ المدفوع يجب أن يكون بين 0 والإجمالي"); }
        if (paidMinor < sum.total && !contactId && !party.trim()) { setBusy(false); return notifyRef.current("err", "اختر أو اكتب اسم العميل للفاتورة الآجلة أو الجزئية"); }
      }

      const { data: inv, error: e1 } = await supabase.from("invoices").insert({
        org_id: orgId, branch_id: branchId || null, kind, number: num.trim(), party_name: party.trim() || null,
        currency: curr, issue_date: issueDate, due_date: dueDate || null, status: "draft",
        total_minor: sum.total.toString(), created_by: userId,
      }).select("id").single();
      if (e1 || !inv) { setBusy(false); return notifyRef.current("err", `تعذر الحفظ: ${e1?.message ?? ""}`); }

      const { error: e2 } = await supabase.from("invoice_lines").insert(resolved.map((x) => ({
        invoice_id: inv.id, org_id: orgId, product_id: x.product_id, qty_milli: x.qty_milli.toString(),
        unit_minor: x.unit_minor.toString(), discount_bp: x.discount_bp, tax_bp: x.tax_bp,
      })));
      if (e2) { setBusy(false); return notifyRef.current("err", `تعذر حفظ السطور: ${e2.message}`); }

      if (andPost) {
        if (kind === "sales") {
          const { error: e3 } = await supabase.rpc("post_sales_invoice_pro", {
            p_invoice: inv.id, p_paid_minor: paidMinor.toString(),
            p_contact_id: contactId || null, p_due_date: dueDate || null, p_key: `sales-${inv.id}-${Date.now()}`,
          });
          setBusy(false);
          if (e3) { void load(); return notifyRef.current("err", `حُفظت مسودة لكن تعذر الترحيل: ${e3.message}`); }
        } else {
          const { error: e3 } = await supabase.rpc("post_purchase_invoice", { p_invoice: inv.id, p_key: `purchase-${inv.id}-${Date.now()}` });
          setBusy(false);
          if (e3) { void load(); return notifyRef.current("err", `حُفظت مسودة لكن تعذر الترحيل: ${e3.message}`); }
        }
        notifyRef.current("ok", "تم الترحيل وتحديث المخزون والديون بدقة 100% ✓");
        onPosted();
      } else {
        setBusy(false);
        notifyRef.current("ok", "تم حفظ المسودة ✓");
      }
      setParty(""); setContactId(""); setPaidInput(""); setDueDate("");
      setNum(`${kind === "sales" ? "INV" : "PUR"}-${Date.now().toString().slice(-6)}`);
      setLines([{ productId: "", itemQuery: "", qty: "1", unitPrice: "", discPct: "0", taxPct: "0" }]);
      void load();
    } catch (ex) { setBusy(false); notifyRef.current("err", ex instanceof Error ? ex.message : "خطأ بالفاتورة"); }
  }

  async function postDraft(inv: Invoice) {
    setBusy(true);
    const { error } = inv.kind === "sales"
      ? await supabase.rpc("post_sales_invoice_pro", { p_invoice: inv.id, p_paid_minor: String(inv.total_minor), p_contact_id: null, p_due_date: inv.due_date ?? null, p_key: `sales-${inv.id}-${Date.now()}` })
      : await supabase.rpc("post_purchase_invoice", { p_invoice: inv.id, p_key: `purchase-${inv.id}-${Date.now()}` });
    setBusy(false);
    if (error) return notifyRef.current("err", `تعذر الترحيل: ${error.message}`);
    notifyRef.current("ok", `تم ترحيل الفاتورة ${inv.number} ✓`); void load(); onPosted();
  }

  function triggerThermalPrint(inv: Invoice) {
    setPrintInv(inv);
    window.setTimeout(() => window.print(), 120);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-bold text-base text-[#152743] flex items-center gap-2"><ShoppingCart className="w-5 h-5 text-[#2869DB]" /> {kind === "sales" ? "فواتير المبيعات الذكية (باركود + كاميرا)" : "المشتريات وتوريد المخزون"}</h2>
        <div className="flex gap-2">
          {canCfg && <button type="button" onClick={() => setShowCfg((v) => !v)} className="flex items-center gap-1 px-3 py-1.5 bg-white border border-[#E4EAF2] text-[#152743] rounded-xl text-xs font-bold"><Settings2 className="w-3.5 h-3.5" /> ربط الحسابات</button>}
          <button type="button" onClick={() => void load()} className="flex items-center gap-1 px-3 py-1.5 bg-white border border-[#E4EAF2] text-[#152743] rounded-xl text-xs font-bold"><RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} /> تحديث</button>
        </div>
      </div>

      {/* شريط الباركود + قراءة الفاتورة بالكاميرا داخل شاشة البيع مباشرة */}
      {canWrite && (
        <div className="bg-white border border-[#E4EAF2] rounded-2xl p-3.5 space-y-2.5 shadow-xs">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void startInlineBarcodeCam()} className={`px-3.5 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 ${bcCamOpen ? "bg-[#B91C1C] text-white" : "bg-[#2869DB] text-white"}`}>
              {bcCamOpen ? <X className="w-4 h-4" /> : <ScanLine className="w-4 h-4" />}
              {bcCamOpen ? "إغلاق كاميرا الباركود" : (kind === "sales" ? "بيع عبر الباركود (كاميرا)" : "توريد بالباركود (كاميرا)")}
            </button>

            <label className="cursor-pointer px-3.5 py-2 rounded-xl bg-[#F7F9FC] hover:bg-[#EDF2F8] border border-[#E4EAF2] text-[#152743] text-xs font-bold inline-flex items-center gap-1.5">
              {ocrBusy ? <Loader2 className="w-4 h-4 animate-spin text-[#2869DB]" /> : <Camera className="w-4 h-4 text-[#2869DB]" />}
              {ocrBusy ? "جارٍ قراءة الفاتورة..." : "إضافة فاتورة بالكاميرا (OCR)"}
              <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleInvoiceOcrFile} />
            </label>

            <form
              onSubmit={(e) => { e.preventDefault(); addProductByBarcode(barcodeInput); setBarcodeInput(""); }}
              className="flex flex-1 min-w-[200px] gap-1.5"
            >
              <input
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                placeholder="امسح الباركود هنا (أو قارئ USB) واضغط Enter..."
                className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] text-xs font-mono text-[#152743]"
              />
              <button type="submit" className="px-3 py-2 rounded-xl bg-[#152743] text-white text-xs font-bold shrink-0">إضافة</button>
            </form>
          </div>

          {bcCamOpen && (
            <div className="relative rounded-xl overflow-hidden border-2 border-[#2869DB]/40 max-w-md mx-auto bg-black">
              <video ref={videoRef} playsInline muted className="w-full block max-h-56 object-cover" />
              <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 h-0.5 bg-[#2869DB]" />
            </div>
          )}
        </div>
      )}

      {canWrite && habits.length > 0 && (
        <div className="bg-white border border-[#E4EAF2] rounded-2xl p-3 space-y-2">
          <div className="text-xs font-bold text-[#152743] flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-[#C5A46D]" /> الأصناف الأكثر مبيعاً (ضغطة واحدة):</div>
          <div className="flex flex-wrap gap-1.5">
            {habits.map((h) => (
              <button key={h.id} type="button" onClick={() => applyHabitProduct(h)} className="px-3 py-1.5 bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743] rounded-xl text-xs font-bold inline-flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-[#2869DB]" /> {h.name} ({formatMinor(h.price_minor, decOf(h.currency))} {h.currency})
              </button>
            ))}
          </div>
        </div>
      )}

      {showCfg && canCfg && (
        <form onSubmit={saveCfg} className="bg-white border border-[#E4EAF2] rounded-2xl p-4 space-y-3">
          <h3 className="font-bold text-sm text-[#152743]">ربط حسابات الفواتير والمخزون</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            {[
              ["receivable_account_id", "الصندوق / الذمم (للمبيعات)"], ["sales_account_id", "إيرادات المبيعات"],
              ["inventory_account_id", "المخزون (الأصول)"], ["cogs_account_id", "تكلفة البضاعة المباعة"],
              ["payable_account_id", "الموردين / الصندوق الدافع (للشراء)"], ["tax_account_id", "الضريبة (اختياري)"],
            ].map(([k, lbl]) => (
              <label key={k} className="space-y-1">
                <span className="block text-[#68778D] font-semibold">{lbl}</span>
                <select value={cfg[k as keyof Cfg]} onChange={(e) => setCfg((c) => ({ ...c, [k]: e.target.value }))} className="w-full px-2.5 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] text-xs">
                  <option value="">— اختر حساباً —</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name} ({a.type})</option>)}
                </select>
              </label>
            ))}
          </div>
          <button disabled={busy} className="bg-[#2869DB] text-white px-4 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1"><Save className="w-3.5 h-3.5" /> حفظ الربط</button>
        </form>
      )}

      {canWrite && (
        <div className="bg-white border border-[#E4EAF2] rounded-2xl p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input value={num} onChange={(e) => setNum(e.target.value)} placeholder="رقم الفاتورة" className="px-3 py-2 rounded-xl bg-[#F7F9FC] text-sm border border-[#E4EAF2]" />
            <div>
              <input value={party} list="sama-customers-list" onChange={(e) => {
                setParty(e.target.value);
                const m = contacts.find((c) => c.name === e.target.value && c.currency === curr);
                setContactId(m?.id ?? "");
              }} placeholder={kind === "sales" ? "اسم الزبون" : "اسم المورد"} className="w-full px-3 py-2 rounded-xl bg-[#F7F9FC] text-sm border border-[#E4EAF2]" />
              <datalist id="sama-customers-list">
                {Array.from(new Set([...topCustomers, ...contacts.map((c) => c.name)])).map((n) => <option key={n} value={n} />)}
              </datalist>
            </div>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="px-3 py-2 rounded-xl bg-[#F7F9FC] text-sm border border-[#E4EAF2]">{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
            <select value={curr} onChange={(e) => setCurr(e.target.value)} className="px-3 py-2 rounded-xl bg-[#F7F9FC] text-sm border border-[#E4EAF2]">{currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}</select>
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className="px-3 py-2 rounded-xl bg-[#F7F9FC] text-sm border border-[#E4EAF2]" />
            {kind === "sales" && (
              <select value={payMode} onChange={(e) => setPayMode(e.target.value as PayMode)} className="px-3 py-2 rounded-xl bg-[#F7F9FC] text-sm border border-[#E4EAF2]">
                <option value="cash">دفع كاش كامل</option>
                <option value="partial">دفع جزئي + الباقي دين</option>
                <option value="credit">آجل بالكامل (دين على الزبون)</option>
              </select>
            )}
          </div>

          {kind === "sales" && payMode !== "cash" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-2.5 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2]">
              {payMode === "partial" && (
                <input value={paidInput} onChange={(e) => setPaidInput(e.target.value)} inputMode="decimal" placeholder={`المبلغ المقبوض الآن (${curr})`} className="px-3 py-2 rounded-xl bg-white text-xs border border-[#E4EAF2]" />
              )}
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} title="تاريخ استحقاق الدين" className="px-3 py-2 rounded-xl bg-white text-xs border border-[#E4EAF2]" />
            </div>
          )}

          <datalist id="sama-products-list">
            {products.filter((p) => p.currency === curr).map((p) => (
              <option key={p.id} value={p.name}>{`${p.sku} — ${formatMinor(p.price_minor, decOf(p.currency))} ${p.currency} (رصيد: ${fmtQty(stock[p.id] ?? "0")})`}</option>
            ))}
          </datalist>

          <div className="space-y-2">
            {lines.map((l, idx) => (
              <div key={idx} className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-center">
                <input value={l.itemQuery} list="sama-products-list" onChange={(e) => editLine(idx, { itemQuery: e.target.value })} placeholder="اسم القطعة أو الباركود" className="col-span-2 px-2.5 py-2 rounded-xl bg-[#F7F9FC] text-xs border border-[#E4EAF2]" />
                <input value={l.qty} onChange={(e) => editLine(idx, { qty: e.target.value })} inputMode="decimal" placeholder="الكمية" className="px-2 py-2 rounded-xl bg-[#F7F9FC] text-xs border border-[#E4EAF2]" />
                <input value={l.unitPrice} onChange={(e) => editLine(idx, { unitPrice: e.target.value })} inputMode="decimal" placeholder="السعر" className="px-2 py-2 rounded-xl bg-[#F7F9FC] text-xs border border-[#E4EAF2]" />
                <input value={l.discPct} onChange={(e) => editLine(idx, { discPct: e.target.value })} inputMode="decimal" placeholder="خصم%" className="px-2 py-2 rounded-xl bg-[#F7F9FC] text-xs border border-[#E4EAF2]" />
                <div className="flex gap-1">
                  <input value={l.taxPct} onChange={(e) => editLine(idx, { taxPct: e.target.value })} inputMode="decimal" placeholder="ضريبة%" className="w-full px-2 py-2 rounded-xl bg-[#F7F9FC] text-xs border border-[#E4EAF2]" />
                  {lines.length > 1 && <button type="button" onClick={() => setLines((p) => p.filter((_, i) => i !== idx))} className="p-2 bg-[#FEF2F2] text-[#B91C1C] rounded-xl"><Trash2 className="w-3.5 h-3.5" /></button>}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#E4EAF2]">
            <button type="button" onClick={() => setLines((p) => [...p, { productId: "", itemQuery: "", qty: "1", unitPrice: "", discPct: "0", taxPct: "0" }])} className="px-3 py-1.5 bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743] rounded-xl text-xs font-bold inline-flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> سطر</button>
            <strong className="text-sm text-[#152743]">الإجمالي: <span className="text-[#2869DB]">{totalPreview !== null ? `${formatMinor(totalPreview, decOf(curr))} ${curr}` : "—"}</span></strong>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void saveInvoice(false)} className="px-3 py-2 bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743] rounded-xl text-xs font-bold">مسودة</button>
              <button type="button" disabled={busy} onClick={() => askConfirm("ترحيل الفاتورة", `ترحيل الفاتورة ${num} بدقة BigInt 100%؟`, () => void saveInvoice(true))} className="bg-[#2869DB] text-white px-4 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1"><Send className="w-3.5 h-3.5" /> ترحيل</button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border border-[#E4EAF2] rounded-2xl p-4 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="border-b border-[#E4EAF2] text-[#68778D]">
            <tr><th className="py-2 text-start">الرقم</th><th className="py-2 text-start">الطرف</th><th className="py-2 text-end">الإجمالي</th><th className="py-2 text-end">المدفوع / المتبقي</th><th className="py-2 text-center">الحالة</th><th className="py-2 text-end">إجراء</th></tr>
          </thead>
          <tbody className="divide-y divide-[#E4EAF2]">
            {invoices.map((inv) => {
              const d = decOf(inv.currency);
              const tot = BigInt(inv.total_minor);
              const paid = BigInt(inv.paid_minor ?? inv.total_minor);
              const rem = tot > paid ? tot - paid : ZERO;
              return (
                <tr key={inv.id}>
                  <td className="py-2 font-mono font-bold text-[#152743]">{inv.number}</td>
                  <td className="py-2">{inv.party_name ?? "نقدي"}</td>
                  <td className="py-2 text-end font-bold text-[#152743]">{formatMinor(tot, d)} {inv.currency}</td>
                  <td className="py-2 text-end">{rem > ZERO ? `متبقي: ${formatMinor(rem, d)}` : "مدفوعة ✓"}</td>
                  <td className="py-2 text-center">{inv.status === "posted" ? "مرحّلة ✓" : "مسودة"}</td>
                  <td className="py-2 text-end">
                    {inv.status === "draft" && canWrite ? (
                      <button type="button" onClick={() => askConfirm("ترحيل", `ترحيل ${inv.number}؟`, () => void postDraft(inv))} className="px-2.5 py-1 bg-[#2869DB] text-white rounded-lg text-[11px] font-bold">ترحيل</button>
                    ) : (
                      <button type="button" onClick={() => triggerThermalPrint(inv)} className="px-2.5 py-1 bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743] rounded-lg text-[11px] font-bold inline-flex items-center gap-1"><Printer className="w-3 h-3" /> طباعة 80mm</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {invoices.length === 0 && <p className="text-xs text-[#68778D] py-2">لا توجد فواتير بعد.</p>}
      </div>

      {printInv && (
        <div className="sama-thermal-print">
          <div style={{ textAlign: "center", borderBottom: "1px dashed #000", paddingBottom: "6px", marginBottom: "6px" }}>
            <strong style={{ fontSize: "15px" }}>Sama Business</strong>
            <div>فاتورة {printInv.kind === "sales" ? "مبيعات" : "مشتريات"} رقم: {printInv.number}</div>
            <div>التاريخ: {printInv.issue_date}</div>
          </div>
          <div>الطرف: {printInv.party_name ?? "زبون نقدي"}</div>
          <div>الإجمالي: {formatMinor(printInv.total_minor, decOf(printInv.currency))} {printInv.currency}</div>
          <div>المدفوع: {formatMinor(printInv.paid_minor ?? printInv.total_minor, decOf(printInv.currency))} {printInv.currency}</div>
          {BigInt(printInv.total_minor) > BigInt(printInv.paid_minor ?? printInv.total_minor) && (
            <div><strong>المتبقي ديناً: {formatMinor(BigInt(printInv.total_minor) - BigInt(printInv.paid_minor ?? printInv.total_minor), decOf(printInv.currency))} {printInv.currency}</strong></div>
          )}
          {printInv.due_date && <div>تاريخ الاستحقاق: {printInv.due_date}</div>}
          {printInv.verification_code && <div style={{ marginTop: "6px", borderTop: "1px dashed #000", paddingTop: "6px", textAlign: "center" }}>رمز التحقق: {printInv.verification_code}</div>}
        </div>
      )}
    </div>
  );
}
