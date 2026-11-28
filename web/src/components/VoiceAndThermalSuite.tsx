"use client";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  Camera, CheckCircle2, Loader2, Mic, MicOff, Package, Plus,
  ScanLine, ShoppingCart, Sparkles, Trash2, Upload, Volume2, VolumeX, X
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { invokeAiCommand, invokeAiOcr, type AiCommandResult, type AiOcrResult } from "@/lib/aiBrain";
import { formatMinor, parseMinor } from "@/lib/money";

type Branch = { id: string; name: string };
type Currency = { code: string; decimals: number };
type ProductRow = {
  id: string; sku: string; name: string; unit: string; currency: string;
  price_minor: string | number; cost_minor: string | number; tax_bp: number; track_stock: boolean;
};
type CartItem = {
  product_id: string; sku: string; name: string; currency: string;
  unit_minor: bigint; qty: number;
};
type PanelMode = "none" | "invoice_ocr" | "barcode_in" | "barcode_sale";
type Props = {
  orgId: string; role: string | null; branches: Branch[]; currencies: Currency[];
  notify: (type: "ok" | "err", text: string) => void;
  onReload: () => void;
};
type SpeechRecEvent = { results: ArrayLike<ArrayLike<{ transcript: string }>> };
type SpeechRecLike = {
  lang: string; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: SpeechRecEvent) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void;
};

const ZERO = BigInt(0);
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fmtQty = (q: string) => formatMinor(q, 3).replace(/\.0+$/, "").replace(/(\.\d*?[1-9])0+$/, "$1");

function playBeep() {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 1100;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.09);
  } catch {}
}

export function VoiceAndThermalSuite({ orgId, role, branches, currencies, notify, onReload }: Props) {
  const [voiceMode, setVoiceMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [pendingCmd, setPendingCmd] = useState<AiCommandResult | null>(null);
  const [pendingOcr, setPendingOcr] = useState<AiOcrResult | null>(null);

  const [panel, setPanel] = useState<PanelMode>("none");
  const [camActive, setCamActive] = useState(false);
  const [camHint, setCamHint] = useState("");

  // بيانات الأصناف والمخزون للبحث السريع بالباركود
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [stockMap, setStockMap] = useState<Record<string, string>>({});

  // حالة إدخال المخزون بالباركود
  const [inCode, setInCode] = useState("");
  const [inMatched, setInMatched] = useState<ProductRow | null>(null);
  const [inName, setInName] = useState("");
  const [inCurr, setInCurr] = useState(currencies[0]?.code ?? "USD");
  const [inCost, setInCost] = useState("");
  const [inPrice, setInPrice] = useState("");
  const [inQty, setInQty] = useState("1");

  // حالة البيع السريع بالباركود
  const [saleCode, setSaleCode] = useState("");
  const [saleCart, setSaleCart] = useState<CartItem[]>([]);
  const [saleParty, setSaleParty] = useState("");
  const [salePayMode, setSalePayMode] = useState<"cash" | "credit">("cash");

  const recRef = useRef<SpeechRecLike | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const panelRef = useRef<PanelMode>(panel);
  panelRef.current = panel;
  const lastScanRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const productsRef = useRef<ProductRow[]>(products);
  productsRef.current = products;

  const canOperate = role ? ["owner", "admin", "accountant", "cashier"].includes(role) : false;
  const decOf = useCallback((c: string) => currencies.find((x) => x.code === c)?.decimals ?? 2, [currencies]);
  const pickCurr = useCallback((c?: string) => (c && currencies.some((x) => x.code === c.toUpperCase()) ? c.toUpperCase() : (currencies[0]?.code ?? "USD")), [currencies]);

  useEffect(() => {
    try { setVoiceMode(window.localStorage.getItem("sama_voice_mode") === "1"); } catch {}
  }, []);

  useEffect(() => {
    if (currencies[0] && !currencies.some((c) => c.code === inCurr)) setInCurr(currencies[0].code);
  }, [currencies, inCurr]);

  const loadProducts = useCallback(async () => {
    if (!orgId) return;
    const [pRes, sRes] = await Promise.all([
      supabase.from("products").select("id,sku,name,unit,currency,price_minor,cost_minor,tax_bp,track_stock").eq("org_id", orgId),
      supabase.from("v_stock_on_hand").select("product_id,qty_milli").eq("org_id", orgId),
    ]);
    setProducts((pRes.data as ProductRow[]) ?? []);
    const sm: Record<string, string> = {};
    for (const r of (sRes.data as Array<{ product_id: string; qty_milli: string }> | null) ?? []) sm[r.product_id] = r.qty_milli;
    setStockMap(sm);
  }, [orgId]);

  useEffect(() => { void loadProducts(); }, [loadProducts]);

  const speakAr = useCallback((text: string) => {
    if (!voiceMode || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ar-SA";
      u.rate = 1.02;
      window.speechSynthesis.speak(u);
    } catch {}
  }, [voiceMode]);

  function toggleVoiceMode() {
    const next = !voiceMode;
    setVoiceMode(next);
    try { window.localStorage.setItem("sama_voice_mode", next ? "1" : "0"); } catch {}
    notify("ok", next ? "تم تفعيل الوضع الصوتي المرتبط بـ Gemini AI" : "تم إيقاف الوضع الصوتي");
  }

  const stopCamera = useCallback(() => {
    window.cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamActive(false);
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  const handleBarcodeForStockIn = useCallback((rawCode: string) => {
    const code = rawCode.trim().toUpperCase();
    if (!code) return;
    setInCode(code);
    const found = productsRef.current.find((p) => p.sku.trim().toUpperCase() === code) ?? null;
    setInMatched(found);
    if (found) {
      setInName(found.name);
      setInCurr(found.currency);
      setInCost(formatMinor(found.cost_minor, decOf(found.currency)).replace(/,/g, ""));
      setInPrice(formatMinor(found.price_minor, decOf(found.currency)).replace(/,/g, ""));
      notify("ok", `تم التعرّف على الصنف: ${found.name} — أدخل الكمية واضغط إدخال للمخزون`);
    } else {
      setInName("");
      setInCost("");
      setInPrice("");
      notify("ok", `باركود جديد (${code}) — أدخل اسم الصنف والسعر والكمية لتسجيله وإدخاله للمخزون`);
    }
  }, [decOf, notify]);

  const handleBarcodeForSale = useCallback((rawCode: string) => {
    const code = rawCode.trim().toUpperCase();
    if (!code) return;
    const found = productsRef.current.find((p) => p.sku.trim().toUpperCase() === code);
    if (!found) {
      notify("err", `الباركود (${code}) غير مسجّل بالمخزون — أضفه أولاً من «إدخال للمخزون بالباركود»`);
      return;
    }
    setSaleCart((prev) => {
      if (prev.length > 0 && prev[0].currency !== found.currency) {
        notify("err", `عملة الصنف (${found.currency}) تختلف عن عملة السلة (${prev[0].currency})`);
        return prev;
      }
      const ex = prev.find((i) => i.product_id === found.id);
      if (ex) {
        return prev.map((i) => i.product_id === found.id ? { ...i, qty: i.qty + 1 } : i);
      }
      return [...prev, {
        product_id: found.id, sku: found.sku, name: found.name,
        currency: found.currency, unit_minor: BigInt(found.price_minor), qty: 1,
      }];
    });
    notify("ok", `أُضيف للسلة: ${found.name} ✓`);
    speakAr(`تمت إضافة ${found.name}`);
  }, [notify, speakAr]);

  const startLiveCamera = useCallback(async (targetMode: PanelMode) => {
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamHint("الكاميرا المباشرة غير مدعومة — استخدم الإدخال اليدوي أو رفع صورة الفاتورة.");
      return;
    }
    setCamHint("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      setCamActive(true);
      await new Promise((r) => window.setTimeout(r, 60));
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      type DetectorLike = { detect: (src: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
      const bw = window as unknown as { BarcodeDetector?: { new (opts?: { formats?: string[] }): DetectorLike; getSupportedFormats?: () => Promise<string[]> } };
      let detector: DetectorLike | null = null;
      if (targetMode !== "invoice_ocr" && bw.BarcodeDetector) {
        try {
          const supported = bw.BarcodeDetector.getSupportedFormats ? await bw.BarcodeDetector.getSupportedFormats() : [];
          const wanted = ["ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "qr_code"].filter((f) => !supported.length || supported.includes(f));
          detector = new bw.BarcodeDetector(wanted.length ? { formats: wanted } : undefined);
        } catch {
          detector = new bw.BarcodeDetector();
        }
      } else if (targetMode !== "invoice_ocr") {
        setCamHint("هذا المتصفح لا يدعم قراءة الباركود التلقائية بالكاميرا — استخدم متصفح Chrome أو اكتب/امسح بقارئ USB في الحقل أدناه.");
      }

      let frame = 0;
      const loop = () => {
        const video = videoRef.current;
        if (!video || !streamRef.current) return;
        if (detector && panelRef.current !== "invoice_ocr" && video.readyState >= 2 && frame % 12 === 0) {
          void detector.detect(video).then((codes) => {
            const val = codes[0]?.rawValue?.trim();
            if (!val) return;
            const now = Date.now();
            if (lastScanRef.current.code === val && now - lastScanRef.current.at < 1800) return;
            lastScanRef.current = { code: val, at: now };
            playBeep();
            if (panelRef.current === "barcode_in") handleBarcodeForStockIn(val);
            if (panelRef.current === "barcode_sale") handleBarcodeForSale(val);
          }).catch(() => {});
        }
        frame++;
        rafRef.current = window.requestAnimationFrame(loop);
      };
      rafRef.current = window.requestAnimationFrame(loop);
    } catch {
      stopCamera();
      notify("err", "تعذر فتح الكاميرا — تأكد من منح إذن الكاميرا وفتح الرابط عبر HTTPS");
    }
  }, [stopCamera, handleBarcodeForStockIn, handleBarcodeForSale, notify]);

  function openPanelMode(next: PanelMode) {
    if (panel === next) {
      stopCamera();
      setPanel("none");
      return;
    }
    setPanel(next);
    void loadProducts();
    void startLiveCamera(next);
  }
  async function analyzeBase64Receipt(b64: string, mime: string) {
    setAiBusy(true);
    setPendingOcr(null);
    try {
      const res = await invokeAiOcr(orgId, b64, mime);
      setAiBusy(false);
      setPendingOcr(res.result);
      notify("ok", `قرأ Gemini الفاتورة بدقة (${res.result.confidence}) ✓`);
      speakAr(`تمت قراءة الفاتورة بقيمة ${res.result.total_amount} ${res.result.currency}`);
    } catch (ex) {
      setAiBusy(false);
      notify("err", `تعذر قراءة الفاتورة: ${ex instanceof Error ? ex.message : "خطأ"}`);
    }
  }

  function handleFileUpload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result ?? "").split(",")[1] ?? "";
      if (b64) void analyzeBase64Receipt(b64, file.type || "image/jpeg");
    };
    reader.readAsDataURL(file);
  }

  function captureInvoiceForOcr() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return notify("err", "انتظر لحظة حتى تعمل الكاميرا بوضوح");
    const w = Math.min(1280, video.videoWidth);
    const h = Math.round((video.videoHeight / video.videoWidth) * w);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    const b64 = canvas.toDataURL("image/jpeg", 0.88).split(",")[1] ?? "";
    if (b64) void analyzeBase64Receipt(b64, "image/jpeg");
  }

  async function saveOcrInvoice(kind: "sales" | "purchase", autoPost: boolean) {
    if (!pendingOcr) return;
    const br = branches[0]?.id;
    const { data: uData } = await supabase.auth.getUser();
    const uid = uData.user?.id;
    if (!br || !uid) return notify("err", "تأكد من التهيئة الذكية (وجود فرع) وتسجيل الدخول");
    try {
      const curr = pickCurr(pendingOcr.currency);
      const d = decOf(curr);
      const tot = parseMinor(pendingOcr.total_amount || "0", d);
      setAiBusy(true);
      const { data: inv, error: e1 } = await supabase.from("invoices").insert({
        org_id: orgId, branch_id: br, kind,
        number: `${kind === "sales" ? "INV-OCR" : "PUR-OCR"}-${Date.now().toString().slice(-5)}`,
        party_name: pendingOcr.party_name || (kind === "sales" ? "زبون (مسح فاتورة)" : "مورد (مسح فاتورة)"),
        currency: curr, issue_date: pendingOcr.issue_date || todayISO(),
        status: "draft", total_minor: tot.toString(), created_by: uid,
      }).select("id").single();
      if (e1 || !inv) { setAiBusy(false); return notify("err", e1?.message ?? "تعذر إنشاء الفاتورة"); }

      const items = pendingOcr.items && pendingOcr.items.length > 0
        ? pendingOcr.items
        : [{ name: pendingOcr.summary_ar || (kind === "sales" ? "مبيعات فاتورة" : "مشتريات فاتورة"), qty: "1", unit_price: pendingOcr.total_amount }];

      for (const it of items) {
        const up = parseMinor(it.unit_price || "0", d);
        const qm = parseMinor(it.qty || "1", 3);
        const { data: qp } = await supabase.rpc("upsert_quick_product", {
          p_org: orgId, p_name: it.name, p_currency: curr,
          p_price_minor: up.toString(), p_cost_minor: kind === "purchase" ? up.toString() : "0",
          p_track_stock: kind === "purchase",
        });
        if (qp && (qp as { id?: string }).id) {
          await supabase.from("invoice_lines").insert({
            invoice_id: inv.id, org_id: orgId, product_id: (qp as { id: string }).id,
            qty_milli: qm.toString(), unit_minor: up.toString(), discount_bp: 0, tax_bp: 0,
          });
        }
      }

      if (autoPost && kind === "sales") {
        const { error: pe } = await supabase.rpc("post_sales_invoice_pro", {
          p_invoice: inv.id, p_paid_minor: tot.toString(), p_contact_id: null, p_due_date: null, p_key: `ocr-sale-${inv.id}`,
        });
        setAiBusy(false);
        if (pe) {
          notify("err", `حُفظت كمسودة بيع لكن تعذر الترحيل الفوري: ${pe.message}`);
        } else {
          notify("ok", "تمت إضافة وترحيل الفاتورة كفاتورة بيع بنجاح بدقة BigInt 100% ✓");
        }
      } else {
        setAiBusy(false);
        notify("ok", kind === "sales" ? "تم حفظ الفاتورة كمسودة بيع بأصنافها — راجعها في تبويب «المبيعات» ✓" : "تم حفظ الفاتورة كمسودة شراء بأصنافها — راجعها في تبويب «المشتريات» ✓");
      }
      setPendingOcr(null);
      onReload();
    } catch (ex) {
      setAiBusy(false);
      notify("err", ex instanceof Error ? ex.message : "خطأ أثناء حفظ الفاتورة");
    }
  }

  async function postOcrAsExpense() {
    if (!pendingOcr) return;
    const br = branches[0]?.id;
    if (!br) return notify("err", "اضغط التهيئة الذكية أولاً لإنشاء الفرع");
    try {
      const curr = pickCurr(pendingOcr.currency);
      const amt = parseMinor(pendingOcr.total_amount || "0", decOf(curr));
      setAiBusy(true);
      const { error } = await supabase.rpc("post_smart_expense", {
        p_org: orgId, p_branch: br, p_date: pendingOcr.issue_date || todayISO(),
        p_currency: curr, p_amount_minor: amt.toString(),
        p_memo: `${pendingOcr.party_name ? pendingOcr.party_name + " — " : ""}${pendingOcr.summary_ar}`,
        p_key: `ocr-exp-${Date.now()}`,
      });
      setAiBusy(false);
      if (error) return notify("err", error.message);
      notify("ok", `تم ترحيل الفاتورة كمصروف (${formatMinor(amt, decOf(curr))} ${curr}) ✓`);
      setPendingOcr(null);
      onReload();
    } catch (ex) { setAiBusy(false); notify("err", ex instanceof Error ? ex.message : "خطأ بالمبلغ"); }
  }

  async function submitBarcodeStockIn(e: FormEvent) {
    e.preventDefault();
    const br = branches[0]?.id;
    if (!br) return notify("err", "اضغط التهيئة الذكية أولاً لإنشاء الفرع");
    try {
      const d = decOf(inCurr);
      const qtyMilli = parseMinor(inQty || "1", 3);
      const costMinor = parseMinor(inCost || "0", d);
      const priceMinor = parseMinor(inPrice || "0", d);
      setAiBusy(true);
      const { data, error } = await supabase.rpc("barcode_stock_in", {
        p_org: orgId, p_branch: br, p_barcode: inCode.trim(),
        p_name: inName.trim(), p_currency: inCurr,
        p_price_minor: priceMinor.toString(), p_cost_minor: costMinor.toString(),
        p_qty_milli: qtyMilli.toString(), p_post_entry: true,
        p_key: `bc-in-${inCode.trim()}-${Date.now()}`,
      });
      setAiBusy(false);
      if (error) return notify("err", `تعذر الإدخال للمخزون: ${error.message}`);
      const res = data as { name: string; sku: string; qty_after_milli: string };
      notify("ok", `تم إدخال «${res.name}» (${res.sku}) للمخزون ✓ الرصيد الجديد: ${fmtQty(res.qty_after_milli)}`);
      setInCode(""); setInMatched(null); setInName(""); setInQty("1");
      void loadProducts();
      onReload();
    } catch (ex) { setAiBusy(false); notify("err", ex instanceof Error ? ex.message : "بيانات غير صالحة"); }
  }

  async function confirmBarcodeQuickSale() {
    if (!saleCart.length) return notify("err", "امسح باركود منتج واحد على الأقل أولاً");
    const br = branches[0]?.id;
    const { data: uData } = await supabase.auth.getUser();
    const uid = uData.user?.id;
    if (!br || !uid) return notify("err", "تأكد من وجود فرع وتسجيل الدخول");
    if (salePayMode === "credit" && !saleParty.trim()) return notify("err", "اكتب اسم العميل للبيع الآجل");
    try {
      const curr = saleCart[0].currency;
      const totalMinor = saleCart.reduce((s, it) => s + it.unit_minor * BigInt(it.qty), ZERO);
      setAiBusy(true);
      const invNum = `POS-${Date.now().toString().slice(-6)}`;
      const { data: inv, error: e1 } = await supabase.from("invoices").insert({
        org_id: orgId, branch_id: br, kind: "sales", number: invNum,
        party_name: saleParty.trim() || null, currency: curr,
        issue_date: todayISO(), status: "draft", total_minor: totalMinor.toString(), created_by: uid,
      }).select("id").single();
      if (e1 || !inv) { setAiBusy(false); return notify("err", e1?.message ?? "تعذر إنشاء الفاتورة"); }

      const { error: e2 } = await supabase.from("invoice_lines").insert(saleCart.map((it) => ({
        invoice_id: inv.id, org_id: orgId, product_id: it.product_id,
        qty_milli: (BigInt(it.qty) * BigInt(1000)).toString(),
        unit_minor: it.unit_minor.toString(), discount_bp: 0, tax_bp: 0,
      })));
      if (e2) { setAiBusy(false); return notify("err", e2.message); }

      const paidMinor = salePayMode === "credit" ? ZERO : totalMinor;
      const { error: e3 } = await supabase.rpc("post_sales_invoice_pro", {
        p_invoice: inv.id, p_paid_minor: paidMinor.toString(),
        p_contact_id: null, p_due_date: null, p_key: `pos-bc-${inv.id}`,
      });
      setAiBusy(false);
      if (e3) return notify("err", `تعذر ترحيل فاتورة البيع: ${e3.message}`);
      notify("ok", `تم إصدار وترحيل فاتورة البيع ${invNum} عبر الباركود بدقة BigInt 100% ✓`);
      speakAr("تم إصدار فاتورة البيع بالباركود بنجاح");
      setSaleCart([]); setSaleParty(""); setSaleCode("");
      void loadProducts();
      onReload();
    } catch (ex) { setAiBusy(false); notify("err", ex instanceof Error ? ex.message : "خطأ بالبيع"); }
  }

  async function runVoiceWithGemini(spoken: string) {
    const clean = spoken.trim();
    if (!clean) return;
    setTranscript(clean);
    setAiBusy(true);
    setPendingCmd(null);
    try {
      const res = await invokeAiCommand(orgId, clean);
      setAiBusy(false);
      if (res.result.action === "question") { notify("ok", res.result.reply_ar); speakAr(res.result.reply_ar); return; }
      setPendingCmd(res.result);
      speakAr(`فهمت أمرك: ${res.result.summary_ar}. اضغط اعتماد للتنفيذ.`);
    } catch (ex) {
      setAiBusy(false);
      notify("err", `تعذر الاتصال بعقل Gemini: ${ex instanceof Error ? ex.message : "خطأ"}`);
    }
  }

  async function executePendingCommand() {
    if (!pendingCmd) return;
    const br = branches[0]?.id;
    const curr = pickCurr(pendingCmd.currency);
    const d = decOf(curr);
    setAiBusy(true);
    try {
      if (pendingCmd.action === "expense") {
        if (!br) throw new Error("اضغط التهيئة الذكية أولاً لإنشاء الفرع");
        const amt = parseMinor(pendingCmd.amount ?? "0", d);
        const { error } = await supabase.rpc("post_smart_expense", {
          p_org: orgId, p_branch: br, p_date: todayISO(), p_currency: curr,
          p_amount_minor: amt.toString(), p_memo: pendingCmd.memo || pendingCmd.summary_ar, p_key: `ai-exp-${Date.now()}`,
        });
        if (error) throw new Error(error.message);
      } else if (pendingCmd.action === "debt_in") {
        if (!br) throw new Error("اضغط التهيئة الذكية أولاً لإنشاء الفرع");
        const amt = parseMinor(pendingCmd.amount ?? "0", d);
        const { error } = await supabase.rpc("post_smart_debt_in", {
          p_org: orgId, p_branch: br, p_date: todayISO(), p_currency: curr,
          p_amount_minor: amt.toString(), p_party: pendingCmd.party_name || "دائن",
          p_memo: pendingCmd.memo || pendingCmd.summary_ar, p_key: `ai-debt-${Date.now()}`,
        });
        if (error) throw new Error(error.message);
      } else if (pendingCmd.action === "add_product") {
        const price = parseMinor(pendingCmd.amount ?? "0", d);
        const { error } = await supabase.rpc("upsert_quick_product", {
          p_org: orgId, p_name: pendingCmd.product_name || pendingCmd.summary_ar,
          p_currency: curr, p_price_minor: price.toString(), p_cost_minor: "0", p_track_stock: false,
        });
        if (error) throw new Error(error.message);
      } else if (pendingCmd.action === "debt_collect") {
        if (!br || !pendingCmd.contact_id) throw new Error("لم يتم تحديد العميل للتحصيل");
        const amt = parseMinor(pendingCmd.amount ?? "0", d);
        const { error } = await supabase.rpc("post_debt_collection", {
          p_org: orgId, p_branch: br, p_contact: pendingCmd.contact_id, p_date: todayISO(),
          p_amount_minor: amt.toString(), p_key: `ai-col-${Date.now()}`,
        });
        if (error) throw new Error(error.message);
      } else if (pendingCmd.action === "quick_sale") {
        if (!br) throw new Error("اضغط التهيئة الذكية أولاً لإنشاء الفرع");
        const { data: uData } = await supabase.auth.getUser();
        const uid = uData.user?.id;
        if (!uid) throw new Error("سجّل الدخول مجدداً");
        let pid = pendingCmd.product_id || "";
        const qtyMilli = parseMinor(pendingCmd.qty || "1", 3);
        const totalMinor = parseMinor(pendingCmd.amount || "0", d);
        const unitMinor = qtyMilli > ZERO ? (totalMinor * BigInt(1000)) / qtyMilli : totalMinor;
        if (!pid) {
          const { data: qp, error: qe } = await supabase.rpc("upsert_quick_product", {
            p_org: orgId, p_name: pendingCmd.product_name || "مبيعات عامة",
            p_currency: curr, p_price_minor: unitMinor.toString(), p_cost_minor: "0", p_track_stock: false,
          });
          if (qe || !qp) throw new Error(qe?.message ?? "تعذر إنشاء الصنف");
          pid = (qp as { id: string }).id;
        }
        const { data: inv, error: e1 } = await supabase.from("invoices").insert({
          org_id: orgId, branch_id: br, kind: "sales", number: `AI-${Date.now().toString().slice(-6)}`,
          party_name: pendingCmd.party_name || null, currency: curr,
          issue_date: todayISO(), status: "draft", total_minor: totalMinor.toString(), created_by: uid,
        }).select("id").single();
        if (e1 || !inv) throw new Error(e1?.message ?? "تعذر إنشاء الفاتورة");
        await supabase.from("invoice_lines").insert({
          invoice_id: inv.id, org_id: orgId, product_id: pid,
          qty_milli: qtyMilli.toString(), unit_minor: unitMinor.toString(), discount_bp: 0, tax_bp: 0,
        });
        const paidMinor = pendingCmd.payment_mode === "credit" ? ZERO : (pendingCmd.payment_mode === "partial" ? parseMinor(pendingCmd.paid_amount || "0", d) : totalMinor);
        const { error: e3 } = await supabase.rpc("post_sales_invoice_pro", {
          p_invoice: inv.id, p_paid_minor: paidMinor.toString(),
          p_contact_id: pendingCmd.contact_id || null, p_due_date: null, p_key: `ai-sale-${inv.id}`,
        });
        if (e3) throw new Error(e3.message);
      }
      setAiBusy(false);
      notify("ok", `تم التنفيذ بنجاح بدقة BigInt 100%: ${pendingCmd.summary_ar} ✓`);
      setPendingCmd(null);
      onReload();
    } catch (ex) { setAiBusy(false); notify("err", ex instanceof Error ? ex.message : "تعذر التنفيذ"); }
  }

  function startListening() {
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRecLike; webkitSpeechRecognition?: new () => SpeechRecLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return notify("err", "المتصفح لا يدعم الإملاء الصوتي — استخدم متصفح Chrome");
    if (listening && recRef.current) { recRef.current.stop(); setListening(false); return; }
    const rec = new Ctor();
    rec.lang = "ar-SA"; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onresult = (e) => { const text = e.results?.[0]?.[0]?.transcript ?? ""; setListening(false); void runVoiceWithGemini(text); };
    rec.onerror = () => { setListening(false); notify("err", "تعذر التقاط الصوت — تأكد من إذن الميكروفون"); };
    rec.onend = () => setListening(false);
    recRef.current = rec; setListening(true); rec.start();
  }

  const cartCurr = saleCart[0]?.currency ?? (currencies[0]?.code ?? "USD");
  const cartTotal = saleCart.reduce((s, i) => s + i.unit_minor * BigInt(i.qty), ZERO);

  return (
    <div className="bg-white border border-[#E4EAF2] rounded-2xl p-3.5 sm:p-4 space-y-3 mb-4 shadow-xs">
      {/* شريط الأزرار الذكي (بدون كاميرا حرارية: صوت + قراءة فواتير OCR + باركود مخزون + باركود بيع) */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => openPanelMode("invoice_ocr")} className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 transition ${panel === "invoice_ocr" ? "bg-[#2869DB] text-white" : "bg-[#F7F9FC] text-[#152743] border border-[#E4EAF2]"}`}>
          <Camera className="w-4 h-4" /> كاميرا قراءة الفواتير (OCR)
        </button>

        {canOperate && (
          <label className="cursor-pointer px-3 py-2 rounded-xl bg-[#F7F9FC] hover:bg-[#EDF2F8] text-[#152743] border border-[#E4EAF2] text-xs font-bold inline-flex items-center gap-1.5">
            <Upload className="w-4 h-4 text-[#2869DB]" /> رفع صورة فاتورة
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleFileUpload} />
          </label>
        )}

        {canOperate && (
          <button type="button" onClick={() => openPanelMode("barcode_in")} className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 transition ${panel === "barcode_in" ? "bg-[#152743] text-white" : "bg-[#F7F9FC] text-[#152743] border border-[#E4EAF2]"}`}>
            <Package className="w-4 h-4 text-[#C5A46D]" /> إدخال للمخزون بالباركود
          </button>
        )}

        {canOperate && (
          <button type="button" onClick={() => openPanelMode("barcode_sale")} className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 transition ${panel === "barcode_sale" ? "bg-[#2869DB] text-white" : "bg-[#F7F9FC] text-[#152743] border border-[#E4EAF2]"}`}>
            <ScanLine className="w-4 h-4 text-[#15803D]" /> بيع عبر الباركود
          </button>
        )}

        <button type="button" disabled={aiBusy} onClick={startListening} className={`px-3 py-2 rounded-xl text-xs font-bold inline-flex items-center gap-1.5 ${listening ? "bg-[#B91C1C] text-white animate-pulse" : "bg-[#F7F9FC] text-[#152743] border border-[#E4EAF2]"}`}>
          {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4 text-[#2869DB]" />}
          {listening ? "تحدث الآن..." : "أمر صوتي"}
        </button>

        <button type="button" onClick={toggleVoiceMode} className="p-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743]" title={voiceMode ? "إيقاف الرد الصوتي" : "تفعيل الرد الصوتي"}>
          {voiceMode ? <Volume2 className="w-4 h-4 text-[#2869DB]" /> : <VolumeX className="w-4 h-4 text-[#68778D]" />}
        </button>
      </div>

      {transcript && <div className="text-xs text-[#68778D]">آخر أمر صوتي: «{transcript}»</div>}

      {/* لوحة الكاميرا الحية (قراءة فواتير واضحة أو باركود مخزون أو باركود بيع) */}
      {panel !== "none" && (
        <div className="border border-[#E4EAF2] rounded-2xl p-3.5 bg-[#F7F9FC] space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="font-bold text-xs sm:text-sm text-[#152743] flex items-center gap-1.5">
              {panel === "invoice_ocr" && <><Camera className="w-4 h-4 text-[#2869DB]" /> كاميرا قراءة الفواتير الورقية (Gemini OCR)</>}
              {panel === "barcode_in" && <><Package className="w-4 h-4 text-[#152743]" /> قراءة باركود لإدخال البضاعة للمخزون</>}
              {panel === "barcode_sale" && <><ShoppingCart className="w-4 h-4 text-[#15803D]" /> البيع السريع عبر الباركود</>}
            </div>
            <button type="button" onClick={() => { stopCamera(); setPanel("none"); }} className="p-1.5 rounded-lg bg-white border border-[#E4EAF2] text-[#152743]"><X className="w-4 h-4" /></button>
          </div>

          <canvas ref={canvasRef} className="hidden" />

          {camActive && (
            <div className="relative rounded-xl overflow-hidden border-2 border-[#2869DB]/40 max-w-md mx-auto bg-black">
              <video ref={videoRef} playsInline muted className="w-full block max-h-64 object-cover" />
              {panel !== "invoice_ocr" && (
                <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 h-0.5 bg-[#2869DB] shadow-[0_0_8px_#2869DB]" />
              )}
            </div>
          )}

          {camHint && <p className="text-xs text-[#C2410C] font-semibold">{camHint}</p>}

          {/* أ. أزرار وضع قراءة الفواتير OCR */}
          {panel === "invoice_ocr" && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-[#68778D]">وجّه الكاميرا نحو الفاتورة بوضوح ثم اضغط التقاط</span>
              <button type="button" disabled={aiBusy} onClick={captureInvoiceForOcr} className="px-4 py-2.5 bg-[#2869DB] text-white rounded-xl text-xs font-bold inline-flex items-center gap-1.5">
                {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} التقاط وقراءة الفاتورة بـ Gemini
              </button>
            </div>
          )}

          {/* ب. نموذج إدخال المخزون بالباركود */}
          {panel === "barcode_in" && (
            <form onSubmit={submitBarcodeStockIn} className="bg-white border border-[#E4EAF2] rounded-xl p-3 space-y-2.5 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div className="flex gap-1.5 sm:col-span-2">
                  <input
                    required
                    value={inCode}
                    onChange={(e) => setInCode(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleBarcodeForStockIn(inCode); } }}
                    placeholder="الباركود (يُملأ تلقائياً بالكاميرا أو قارئ USB)"
                    className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] font-mono text-[#152743]"
                  />
                  <button type="button" onClick={() => handleBarcodeForStockIn(inCode)} className="px-3 py-2 rounded-xl bg-[#EDF2F8] text-[#152743] font-bold shrink-0">فحص</button>
                </div>
                <select value={inCurr} onChange={(e) => setInCurr(e.target.value)} className="px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743]">
                  {currencies.map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                </select>
              </div>

              {inMatched && (
                <div className="p-2 rounded-lg bg-[#ECFDF3] border border-[#BBF7D0] text-[#15803D] font-bold">
                  صنف مسجّل: {inMatched.name} — الرصيد الحالي بالمخزون: {fmtQty(stockMap[inMatched.id] ?? "0")} {inMatched.unit}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <input required value={inName} onChange={(e) => setInName(e.target.value)} placeholder="اسم المنتج / القطعة" className="col-span-2 sm:col-span-1 px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743]" />
                <input required value={inQty} onChange={(e) => setInQty(e.target.value)} inputMode="decimal" placeholder="الكمية المُدخلة" className="px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743]" />
                <input value={inCost} onChange={(e) => setInCost(e.target.value)} inputMode="decimal" placeholder={`سعر التكلفة (${inCurr})`} className="px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743]" />
                <input value={inPrice} onChange={(e) => setInPrice(e.target.value)} inputMode="decimal" placeholder={`سعر البيع (${inCurr})`} className="px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] text-[#152743]" />
              </div>

              <button type="submit" disabled={aiBusy} className="w-full sm:w-auto px-5 py-2.5 bg-[#152743] text-white rounded-xl font-bold inline-flex items-center justify-center gap-1.5">
                {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} إدخال الكمية للمخزون الآن
              </button>
            </form>
          )}

          {/* ج. سلة البيع السريع عبر الباركود */}
          {panel === "barcode_sale" && (
            <div className="bg-white border border-[#E4EAF2] rounded-xl p-3 space-y-3 text-xs">
              <form
                onSubmit={(e) => { e.preventDefault(); handleBarcodeForSale(saleCode); setSaleCode(""); }}
                className="flex gap-1.5"
              >
                <input
                  value={saleCode}
                  onChange={(e) => setSaleCode(e.target.value)}
                  placeholder="امسح الباركود بالكاميرا أو بقارئ USB ثم Enter لإضافته للفاتورة..."
                  className="flex-1 min-w-0 px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] font-mono text-[#152743]"
                />
                <button type="submit" className="px-3.5 py-2 rounded-xl bg-[#2869DB] text-white font-bold shrink-0">إضافة</button>
              </form>

              {saleCart.length > 0 ? (
                <div className="space-y-2">
                  {saleCart.map((it) => (
                    <div key={it.product_id} className="p-2.5 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2] flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-bold text-[#152743] truncate">{it.name}</div>
                        <div className="text-[11px] text-[#68778D] font-mono">{it.sku} • {formatMinor(it.unit_minor, decOf(it.currency))} {it.currency}</div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button type="button" onClick={() => setSaleCart((p) => p.map((x) => x.product_id === it.product_id ? { ...x, qty: x.qty - 1 } : x).filter((x) => x.qty > 0))} className="w-7 h-7 rounded-lg bg-white border border-[#E4EAF2] font-bold">-</button>
                        <span className="w-7 text-center font-bold">{it.qty}</span>
                        <button type="button" onClick={() => setSaleCart((p) => p.map((x) => x.product_id === it.product_id ? { ...x, qty: x.qty + 1 } : x))} className="w-7 h-7 rounded-lg bg-white border border-[#E4EAF2] font-bold">+</button>
                        <button type="button" onClick={() => setSaleCart((p) => p.filter((x) => x.product_id !== it.product_id))} className="p-1.5 text-[#B91C1C]"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </div>
                  ))}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                    <input value={saleParty} onChange={(e) => setSaleParty(e.target.value)} placeholder="اسم العميل (اختياري للنقدي / إلزامي للآجل)" className="px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2]" />
                    <select value={salePayMode} onChange={(e) => setSalePayMode(e.target.value as "cash" | "credit")} className="px-3 py-2 rounded-xl bg-[#F7F9FC] border border-[#E4EAF2]">
                      <option value="cash">دفع كاش كامل</option>
                      <option value="credit">آجل (دين على العميل)</option>
                    </select>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#E4EAF2]">
                    <div className="font-bold text-sm text-[#152743]">الإجمالي: <span className="text-[#2869DB]">{formatMinor(cartTotal, decOf(cartCurr))} {cartCurr}</span></div>
                    <button type="button" disabled={aiBusy} onClick={() => void confirmBarcodeQuickSale()} className="px-4 py-2.5 bg-[#2869DB] text-white rounded-xl font-bold inline-flex items-center gap-1.5">
                      {aiBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} إصدار وترحيل فاتورة البيع
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-[#68778D] text-center py-2">السلة فارغة — وجّه الكاميرا نحو باركود المنتج لإضافته تلقائياً.</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* بطاقة تأكيد الأمر الصوتي الذكي */}
      {pendingCmd && (
        <div className="p-3.5 rounded-2xl bg-[#ECFDF3] border border-[#BBF7D0] space-y-2 text-xs text-[#152743]">
          <div className="font-bold flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[#15803D]"><Sparkles className="w-4 h-4" /> فهم Gemini أمرك الصوتي — راجع ثم اعتمد:</span>
            <button type="button" onClick={() => setPendingCmd(null)}><X className="w-4 h-4" /></button>
          </div>
          <div>الوصف: <strong>{pendingCmd.summary_ar}</strong> | المبلغ: <strong>{pendingCmd.amount ?? "—"} {pickCurr(pendingCmd.currency)}</strong></div>
          {canOperate && (
            <div className="flex gap-2">
              <button type="button" disabled={aiBusy} onClick={() => void executePendingCommand()} className="px-4 py-2 bg-[#2869DB] text-white rounded-xl font-bold inline-flex items-center gap-1"><CheckCircle2 className="w-4 h-4" /> اعتماد وترحيل</button>
              <button type="button" onClick={() => setPendingCmd(null)} className="px-3 py-2 bg-white border border-[#E4EAF2] rounded-xl font-bold">إلغاء</button>
            </div>
          )}
        </div>
      )}

      {/* بطاقة نتيجة قراءة الفاتورة بـ Gemini OCR — تشمل الإضافة المباشرة كفاتورة بيع أو شراء أو مصروف */}
      {pendingOcr && (
        <div className="p-3.5 rounded-2xl bg-[#F0F6FF] border border-[#BFDBFE] space-y-2.5 text-xs text-[#152743]">
          <div className="font-bold flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[#2869DB]"><Camera className="w-4 h-4" /> تمت قراءة الفاتورة بـ Gemini OCR (ثقة: {pendingOcr.confidence})</span>
            <button type="button" onClick={() => setPendingOcr(null)}><X className="w-4 h-4" /></button>
          </div>
          <div>الطرف: <strong>{pendingOcr.party_name || "غير محدد"}</strong> • التاريخ: <strong>{pendingOcr.issue_date || todayISO()}</strong></div>
          <div>الإجمالي: <strong className="text-sm text-[#2869DB]">{pendingOcr.total_amount} {pickCurr(pendingOcr.currency)}</strong> — {pendingOcr.summary_ar}</div>
          {pendingOcr.items && pendingOcr.items.length > 0 && (
            <div className="p-2.5 rounded-xl bg-white border border-[#E4EAF2] space-y-1">
              {pendingOcr.items.map((it, idx) => (
                <div key={idx} className="flex justify-between"><span>{it.name} × {it.qty}</span><strong>{it.unit_price}</strong></div>
              ))}
            </div>
          )}
          {canOperate && (
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="button" disabled={aiBusy} onClick={() => void saveOcrInvoice("sales", true)} className="px-3.5 py-2 bg-[#2869DB] text-white rounded-xl font-bold inline-flex items-center gap-1">
                <ShoppingCart className="w-3.5 h-3.5" /> إضافة وترحيل كفاتورة بيع
              </button>
              <button type="button" disabled={aiBusy} onClick={() => void saveOcrInvoice("sales", false)} className="px-3.5 py-2 bg-white border border-[#2869DB] text-[#2869DB] rounded-xl font-bold">
                حفظ كمسودة بيع
              </button>
              <button type="button" disabled={aiBusy} onClick={() => void saveOcrInvoice("purchase", false)} className="px-3.5 py-2 bg-white border border-[#E4EAF2] text-[#152743] rounded-xl font-bold">
                مسودة فاتورة شراء
              </button>
              <button type="button" disabled={aiBusy} onClick={() => void postOcrAsExpense()} className="px-3.5 py-2 bg-white border border-[#E4EAF2] text-[#C2410C] rounded-xl font-bold">
                ترحيل كمصروف
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
