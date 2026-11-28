import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

const cleanJson = (s: string) =>
  s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

async function callGeminiSafe(apiKey: string, payload: Record<string, unknown>) {
  const custom = Deno.env.get("GEMINI_MODEL")?.trim();
  const models = custom
    ? [custom, "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-2.5-flash-lite"]
    : ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-2.5-flash-lite"];

  let lastErr = "Gemini request failed";
  for (const model of Array.from(new Set(models))) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 404) {
      lastErr = `Model ${model} unavailable (404)`;
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastErr = data?.error?.message ?? `HTTP ${res.status}`;
      if (res.status >= 500 || res.status === 429) continue;
      throw new Error(lastErr);
    }
    const parts = (data?.candidates?.[0]?.content?.parts ?? []) as Array<{ text?: string; thought?: boolean }>;
    const text = parts
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("Empty Gemini response");
    return { text, model };
  }
  throw new Error(lastErr);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jsonRes({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return jsonRes({ error: "Missing Authorization token" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const geminiKey = Deno.env.get("GEMINI_API_KEY") ?? "";
    if (!geminiKey) {
      return jsonRes({ error: "GEMINI_API_KEY secret is not configured on Supabase" }, 503);
    }

    const body = await req.json().catch(() => null);
    const orgId = String(body?.org_id ?? "").trim();
    const mode = String(body?.mode ?? "").trim();
    if (!orgId || !["command", "ocr", "cfo"].includes(mode)) {
      return jsonRes({ error: "Invalid org_id or mode" }, 400);
    }

    const sb = createClient(supabaseUrl, supabaseAnon, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    // الإصلاح الأساسي: تمرير التوكن صراحةً لـ getUser(token) داخل Deno
    const { data: userRes, error: userErr } = await sb.auth.getUser(token);
    if (userErr || !userRes?.user) {
      return jsonRes({ error: `Unauthorized: ${userErr?.message ?? "invalid session"}` }, 401);
    }

    // 1. فحص الحصة اليومية (مع مرونة في حال لم تُشغّل دالة الحصة بعد)
    let quota: Record<string, unknown> = { allowed: true, used: 1, limit: 100, remaining: 99 };
    const qRes = await sb.rpc("consume_ai_quota", {
      p_org: orgId,
      p_mode: mode,
      p_model: Deno.env.get("GEMINI_MODEL") ?? "gemini-3.5-flash-lite",
    });
    if (qRes.error) {
      const m = qRes.error.message ?? "";
      if (!m.includes("Could not find the function") && !m.includes("does not exist")) {
        return jsonRes({ error: `Quota: ${m}` }, 403);
      }
    } else if (qRes.data) {
      quota = qRes.data as Record<string, unknown>;
    }

    // 2. جلب بيانات الشركة الحية (عبر get_ai_org_context أو مباشرةً عبر RLS عند الحاجة)
    let ctx: Record<string, unknown> | null = null;
    const cRes = await sb.rpc("get_ai_org_context", { p_org: orgId });
    if (!cRes.error && cRes.data) {
      ctx = cRes.data as Record<string, unknown>;
    } else {
      const [orgR, curR, prR, ctR, invR, balR] = await Promise.all([
        sb.from("organizations").select("id,name,base_currency").eq("id", orgId).maybeSingle(),
        sb.from("currencies").select("code,decimals"),
        sb.from("products").select("id,sku,name,currency,price_minor,cost_minor,track_stock").eq("org_id", orgId).limit(60),
        sb.from("contacts").select("id,name,kind,currency,balance_minor,due_date").eq("org_id", orgId).order("balance_minor", { ascending: false }).limit(50),
        sb.from("invoices").select("kind,status,currency,total_minor,paid_minor,issue_date,party_name").eq("org_id", orgId).order("created_at", { ascending: false }).limit(40),
        sb.from("v_account_balances").select("code,name,type,currency,debit,credit").eq("org_id", orgId).limit(100),
      ]);
      if (orgR.error || !orgR.data) {
        return jsonRes({ error: `Org access denied: ${orgR.error?.message ?? cRes.error?.message ?? "forbidden"}` }, 403);
      }
      ctx = {
        org_name: orgR.data.name,
        base_currency: orgR.data.base_currency,
        today: new Date().toISOString().slice(0, 10),
        currencies: curR.data ?? [],
        products: prR.data ?? [],
        contacts: ctR.data ?? [],
        recent_invoices: invR.data ?? [],
        account_balances: balR.data ?? [],
      };
    }

    const ctxCompact = JSON.stringify(ctx);

    // === الوضع 1: الأوامر الصوتية والنصية ===
    if (mode === "command") {
      const inputText = String(body?.text ?? "").trim();
      if (!inputText) return jsonRes({ error: "Empty command text" }, 400);

      const schema = {
        type: "OBJECT",
        properties: {
          action: { type: "STRING", enum: ["expense", "debt_in", "debt_collect", "quick_sale", "add_product", "question"] },
          amount: { type: "STRING" },
          currency: { type: "STRING" },
          party_name: { type: "STRING" },
          contact_id: { type: "STRING" },
          product_name: { type: "STRING" },
          product_id: { type: "STRING" },
          qty: { type: "STRING" },
          payment_mode: { type: "STRING", enum: ["cash", "credit", "partial"] },
          paid_amount: { type: "STRING" },
          memo: { type: "STRING" },
          summary_ar: { type: "STRING" },
          reply_ar: { type: "STRING" },
        },
        required: ["action", "summary_ar", "reply_ar"],
      };

      const { text, model } = await callGeminiSafe(geminiKey, {
        systemInstruction: {
          parts: [{
            text: "أنت محرك أوامر مالي لنظام Sama Business. حوّل أمر التاجر إلى JSON صارم. المبالغ نصوص عشرية صافية بدون رمز عملة. طابق product_id وcontact_id من السياق الحي إذا وُجد، واستخدم base_currency عند عدم ذكر العملة. إذا كان سؤالاً تحليلياً اختر action='question' وأجبه بدقة في reply_ar اعتماداً فقط على السياق الحي (تذكّر قسمة minor_units على 10^decimals حسب جدول currencies).",
          }],
        },
        contents: [{
          role: "user",
          parts: [{ text: `بيانات الشركة الحية:\n${ctxCompact}\n\nأمر المستخدم:\n${inputText}` }],
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      });

      return jsonRes({ ok: true, mode, model, quota, result: JSON.parse(cleanJson(text)) });
    }

    // === الوضع 2: قراءة الفواتير بالكاميرا (OCR) ===
    if (mode === "ocr") {
      const imgB64 = String(body?.image_base64 ?? "").trim();
      const mimeType = String(body?.mime_type ?? "image/jpeg").trim();
      if (!imgB64 || imgB64.length > 5_500_000) {
        return jsonRes({ error: "Invalid or too large image (max 4MB)" }, 400);
      }

      const schema = {
        type: "OBJECT",
        properties: {
          doc_kind: { type: "STRING", enum: ["expense", "purchase", "sales"] },
          party_name: { type: "STRING" },
          issue_date: { type: "STRING" },
          currency: { type: "STRING" },
          total_amount: { type: "STRING" },
          summary_ar: { type: "STRING" },
          confidence: { type: "STRING", enum: ["high", "medium", "low"] },
          items: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                name: { type: "STRING" },
                qty: { type: "STRING" },
                unit_price: { type: "STRING" },
              },
              required: ["name", "qty", "unit_price"],
            },
          },
        },
        required: ["doc_kind", "currency", "total_amount", "summary_ar", "confidence"],
      };

      const { text, model } = await callGeminiSafe(geminiKey, {
        systemInstruction: {
          parts: [{
            text: "أنت خبير قراءة فواتير وإيصالات (OCR). استخرج البيانات بدقة دون تخمين أرقام غير موجودة. العملة الافتراضية هي base_currency من السياق. المبالغ أرقام عشرية إنجليزية صافية مثل 45.50.",
          }],
        },
        contents: [{
          role: "user",
          parts: [
            { text: `العملات: ${JSON.stringify({ base: ctx.base_currency, currencies: ctx.currencies, today: ctx.today })}\nاقرأ الفاتورة وأعد JSON.` },
            { inlineData: { mimeType, data: imgB64 } },
          ],
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json",
          responseSchema: schema,
        },
      });

      return jsonRes({ ok: true, mode, model, quota, result: JSON.parse(cleanJson(text)) });
    }

    // === الوضع 3: المستشار المالي التنفيذي (AI CFO) ===
    const question = String(body?.question ?? "").trim();
    if (!question) return jsonRes({ error: "Empty question" }, 400);

    const { text, model } = await callGeminiSafe(geminiKey, {
      systemInstruction: {
        parts: [{
          text: "أنت Sama AI CFO، مستشار مالي لنظام Sama Business. اعتمد حصراً على الأرقام الحقيقية المرفقة من قاعدة البيانات. المبالغ مخزنة بوحدات صغرى minor units: اقسمها على 10^decimals حسب جدول currencies (مثلاً USD له decimals=2 فـ 10000 = 100.00 USD، وSYP حسب decimals الخاص به). لا تخلط العملات أبداً. أجب بالعربية بوضوح وإيجاز مع ذكر الأسماء والأرقام الدقيقة.",
        }],
      },
      contents: [{
        role: "user",
        parts: [{ text: `اللقطة المالية الحية:\n${ctxCompact}\n\nسؤال صاحب العمل:\n${question}` }],
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 900,
      },
    });

    return jsonRes({ ok: true, mode, model, quota, reply: text });
  } catch (err) {
    return jsonRes({ error: err instanceof Error ? err.message : "Internal AI error" }, 500);
  }
});
