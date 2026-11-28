import { createClient } from "@supabase/supabase-js";

function normalizeOrigin(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  try { return new URL(v).origin; }
  catch { return v.replace(/\/rest\/v1.*$/i, "").replace(/\/+$/, ""); }
}

const supabaseUrl = normalizeOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
const supabaseKey = (
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  ""
).trim();

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseKey);

export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseKey || "placeholder-key",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);
