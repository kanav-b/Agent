/**
 * The one place that reads process.env.
 *
 * Everything else asks for config through getConfig(), so there is a single
 * spot to look when something is missing. Values are read on first use rather
 * than at import time, which keeps tests from needing real credentials.
 */

export interface Config {
  port: number;
  supabaseUrl: string;
  supabaseSecretKey: string;
}

let cached: Config | undefined;

/**
 * Loads .env if there is one. Node can do this itself, so no extra library is
 * needed. Real environment variables (as used in hosting) still win, and a
 * missing .env is fine.
 */
function loadEnvFile(): void {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file. That is normal in production.
  }
}

export function getConfig(): Config {
  if (cached) {
    return cached;
  }

  loadEnvFile();

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseSecretKey) missing.push("SUPABASE_SECRET_KEY");

  if (missing.length > 0) {
    // Names only — never the values.
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy .env.example to .env and fill them in."
    );
  }

  cached = {
    port: process.env.PORT ? Number(process.env.PORT) : 3000,
    supabaseUrl: supabaseUrl as string,
    supabaseSecretKey: supabaseSecretKey as string
  };

  return cached;
}
