import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getConfig } from "../config.js";

let client: SupabaseClient | undefined;

/**
 * The server-side Supabase client.
 *
 * Built on first use, not at import time, so importing the app in tests does
 * not require credentials. Uses the secret key, which bypasses row level
 * security — this client must never reach a browser.
 */
export function getSupabase(): SupabaseClient {
  if (!client) {
    const { supabaseUrl, supabaseSecretKey } = getConfig();

    client = createClient(supabaseUrl, supabaseSecretKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }

  return client;
}
