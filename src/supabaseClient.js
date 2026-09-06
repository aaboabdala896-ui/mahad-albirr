import { createClient } from "@supabase/supabase-js";

// Public values — safe to ship in frontend code. Row Level Security on
// the Supabase side controls what this key is actually allowed to do.
const SUPABASE_URL = "https://jkyadviotlhvwavwpaky.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_joKgcL70BrfuRCii0pmAyA_3Vpe9qF7";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 5 } },
});
