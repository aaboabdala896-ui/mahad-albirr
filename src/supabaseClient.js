import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Supabase configuration missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your .env file or Vercel environment variables.");
}

const normalizeError = (error) => {
  if (!error) return "تعذّر الاتصال بقاعدة البيانات.";
  if (error.message) return error.message;
  if (error.code) return `تعذّر الاتصال بقاعدة البيانات (رمز ${error.code}).`;
  return "تعذّر الاتصال بقاعدة البيانات.";
};

export const supabase = createClient(SUPABASE_URL || "", SUPABASE_ANON_KEY || "", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  realtime: { params: { eventsPerSecond: 5 } },
  global: {
    fetch: async (...args) => {
      try {
        return await fetch(...args);
      } catch (error) {
        console.error("Supabase fetch error:", error);
        throw error;
      }
    },
  },
});

export const checkSupabaseConnection = async () => {
  try {
    const { error } = await supabase.from("students").select("id", { count: "exact", head: true });
    return !error;
  } catch {
    return false;
  }
};

export const getSupabaseErrorMessage = (error) => normalizeError(error);
