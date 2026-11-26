import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

// Never place the service-role key in this browser client. RLS is the security boundary.
export const supabase = createClient(
  supabaseUrl || "https://placeholder.supabase.co",
  supabaseAnonKey || "placeholder-key",
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
);
