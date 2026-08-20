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
  vapiToolSecret: string;
  /** The master switch. SMS is off unless this is explicitly turned on. */
  smsEnabled: boolean;
  /** Twilio settings. Optional here so tools that never send SMS still run. */
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  shopNotificationNumber?: string;
}

/** The Twilio settings, once they are known to all be present. */
export interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  shopNotificationNumber: string;
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

  const smsEnabled = readSmsEnabled();

  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  const vapiToolSecret = process.env.VAPI_TOOL_SECRET?.trim();

  const missing: string[] = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseSecretKey) missing.push("SUPABASE_SECRET_KEY");
  if (!vapiToolSecret) missing.push("VAPI_TOOL_SECRET");

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
    supabaseSecretKey: supabaseSecretKey as string,
    vapiToolSecret: vapiToolSecret as string,
    smsEnabled,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID?.trim() || undefined,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN?.trim() || undefined,
    twilioFromNumber: process.env.TWILIO_FROM_NUMBER?.trim() || undefined,
    shopNotificationNumber: process.env.SHOP_NOTIFICATION_NUMBER?.trim() || undefined
  };

  return cached;
}

/**
 * Reads the SMS master switch.
 *
 * Off unless explicitly turned on: having Twilio credentials lying around is
 * not a reason to start texting people. Anything other than "true" or "false"
 * is a mistake worth stopping for rather than guessing at.
 */
function readSmsEnabled(): boolean {
  const raw = process.env.SMS_ENABLED?.trim().toLowerCase();

  if (raw === undefined || raw === "") {
    return false;
  }

  if (raw === "true") return true;
  if (raw === "false") return false;

  // The value itself is not echoed, in keeping with never printing env values.
  throw new Error('SMS_ENABLED must be exactly "true" or "false".');
}

/** Whether SMS may be sent at all. */
export function isSmsEnabled(): boolean {
  return getConfig().smsEnabled;
}

/** The Twilio variables that must all be set before any SMS can be sent. */
export const SMS_ENV_VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "SHOP_NOTIFICATION_NUMBER"
] as const;

/** Names of any missing Twilio variables. Empty when SMS is ready to use. */
export function missingSmsConfig(): string[] {
  const config = getConfig();

  const missing: string[] = [];
  if (!config.twilioAccountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!config.twilioAuthToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!config.twilioFromNumber) missing.push("TWILIO_FROM_NUMBER");
  if (!config.shopNotificationNumber) missing.push("SHOP_NOTIFICATION_NUMBER");

  return missing;
}

/**
 * The Twilio settings, or a clear error naming what is missing.
 *
 * Kept separate from getConfig() so anything that never sends SMS — the
 * database check script, for example — still runs without Twilio configured.
 */
export function getSmsConfig(): SmsConfig {
  const missing = missingSmsConfig();

  if (missing.length > 0) {
    // Names only — never the token.
    throw new Error(`SMS is not configured. Missing: ${missing.join(", ")}.`);
  }

  const config = getConfig();

  return {
    accountSid: config.twilioAccountSid as string,
    authToken: config.twilioAuthToken as string,
    fromNumber: config.twilioFromNumber as string,
    shopNotificationNumber: config.shopNotificationNumber as string
  };
}
