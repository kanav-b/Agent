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

/**
 * What is needed to publish an assistant to Vapi.
 *
 * Separate from the running server's configuration on purpose: the phone
 * receptionist works fine without any of it, and only the sync command needs
 * it. The API key is a credential; the tool ids are not.
 */
export interface VapiProvisioningConfig {
  apiKey: string;
  estimateToolId: string;
  appointmentRequestToolId: string;
  callbackRequestToolId: string;
  modelProvider: string;
  model: string;
}

/** The Twilio settings, once the credentials are known to be present. */
export interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /**
   * The global fallback destination for shop alerts. Optional: a shop can set
   * its own `notification_phone`, which takes precedence over this.
   */
  shopNotificationNumber?: string;
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

/** Everything the sync command needs before it may write to Vapi. */
export const VAPI_ENV_VARS = [
  "VAPI_API_KEY",
  "VAPI_ESTIMATE_TOOL_ID",
  "VAPI_APPOINTMENT_REQUEST_TOOL_ID",
  "VAPI_CALLBACK_REQUEST_TOOL_ID"
] as const;

/** Names of any missing Vapi provisioning variables. Empty when ready. */
export function missingVapiConfig(): string[] {
  // Read directly rather than through getConfig(), so a server that never
  // syncs is never asked for any of this.
  const missing: string[] = [];

  for (const name of VAPI_ENV_VARS) {
    if (!process.env[name]?.trim()) {
      missing.push(name);
    }
  }

  return missing;
}

/**
 * The Vapi provisioning settings, or a clear error naming what is missing.
 *
 * Never echoes a value: the names alone are enough to fix the problem, and
 * the API key must not reach a log or an error message.
 */
export function getVapiConfig(): VapiProvisioningConfig {
  const missing = missingVapiConfig();

  if (missing.length > 0) {
    throw new Error(
      `Vapi provisioning is not configured. Missing: ${missing.join(", ")}. ` +
        "See .env.example."
    );
  }

  return {
    apiKey: process.env.VAPI_API_KEY!.trim(),
    estimateToolId: process.env.VAPI_ESTIMATE_TOOL_ID!.trim(),
    appointmentRequestToolId: process.env.VAPI_APPOINTMENT_REQUEST_TOOL_ID!.trim(),
    callbackRequestToolId: process.env.VAPI_CALLBACK_REQUEST_TOOL_ID!.trim(),
    // Only used when creating a brand new assistant. An update keeps whatever
    // the assistant already has.
    modelProvider: process.env.VAPI_MODEL_PROVIDER?.trim() || "openai",
    model: process.env.VAPI_MODEL?.trim() || "gpt-4o"
  };
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

/**
 * The Twilio credentials needed before any SMS can be sent.
 *
 * SHOP_NOTIFICATION_NUMBER is deliberately not here: since shops can each set
 * their own `notification_phone`, the global number is a fallback rather than
 * a requirement. Where a message goes is decided per business at send time.
 */
export const SMS_ENV_VARS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER"
] as const;

/** Names of any missing Twilio credentials. Empty when SMS is ready to use. */
export function missingSmsConfig(): string[] {
  const config = getConfig();

  const missing: string[] = [];
  if (!config.twilioAccountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!config.twilioAuthToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!config.twilioFromNumber) missing.push("TWILIO_FROM_NUMBER");

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
    shopNotificationNumber: config.shopNotificationNumber
  };
}
