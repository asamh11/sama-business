import { supabase } from "@/lib/supabase";

export type AiQuota = { allowed: boolean; used: number; limit: number; remaining: number };

export type AiCommandResult = {
  action: "expense" | "debt_in" | "debt_collect" | "quick_sale" | "add_product" | "question";
  amount?: string;
  currency?: string;
  party_name?: string;
  contact_id?: string;
  product_name?: string;
  product_id?: string;
  qty?: string;
  payment_mode?: "cash" | "credit" | "partial";
  paid_amount?: string;
  memo?: string;
  summary_ar: string;
  reply_ar: string;
};

export type AiOcrResult = {
  doc_kind: "expense" | "purchase" | "sales";
  party_name?: string;
  issue_date?: string;
  currency: string;
  total_amount: string;
  summary_ar: string;
  confidence: "high" | "medium" | "low";
  items?: Array<{ name: string; qty: string; unit_price: string }>;
};

async function callBrain<T>(payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("sama-ai-brain", { body: payload });
  if (error) {
    let detail = error.message;
    try {
      const res = (error as { context?: Response }).context;
      if (res && typeof res.json === "function") {
        const body = await res.json().catch(() => null);
        if (body?.error) detail = String(body.error);
      }
    } catch {}
    throw new Error(detail);
  }
  if (data?.error) throw new Error(String(data.error));
  return data as T;
}

export const invokeAiCommand = (orgId: string, text: string) =>
  callBrain<{ ok: true; model: string; quota: AiQuota; result: AiCommandResult }>({
    org_id: orgId, mode: "command", text,
  });

export const invokeAiOcr = (orgId: string, imageBase64: string, mimeType: string) =>
  callBrain<{ ok: true; model: string; quota: AiQuota; result: AiOcrResult }>({
    org_id: orgId, mode: "ocr", image_base64: imageBase64, mime_type: mimeType,
  });

export const invokeAiCfo = (orgId: string, question: string) =>
  callBrain<{ ok: true; model: string; quota: AiQuota; reply: string }>({
    org_id: orgId, mode: "cfo", question,
  });
