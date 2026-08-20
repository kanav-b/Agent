import twilio from "twilio";
import { getSmsConfig } from "../config.js";

/**
 * The only place that talks to Twilio.
 *
 * Server-side only: the auth token is a credential and must never reach a
 * browser, a log line, or a response body.
 */

let client: ReturnType<typeof twilio> | undefined;

function getClient(): ReturnType<typeof twilio> {
  if (!client) {
    const { accountSid, authToken } = getSmsConfig();
    client = twilio(accountSid, authToken);
  }

  return client;
}

export interface SendResult {
  providerMessageId: string;
}

/** Raised when Twilio rejects a message. Carries the provider code, nothing else. */
export class SmsSendError extends Error {
  readonly providerErrorCode: string | null;

  constructor(providerErrorCode: string | null) {
    // Deliberately generic: the original error can carry the number and body.
    super("The SMS provider rejected the message.");
    this.name = "SmsSendError";
    this.providerErrorCode = providerErrorCode;
  }
}

/**
 * Sends one SMS.
 *
 * Any provider failure is re-thrown as SmsSendError with just the code, so a
 * Twilio exception — which can quote the destination number and the message
 * body — never escapes this function.
 */
export async function sendSms(to: string, body: string): Promise<SendResult> {
  const { fromNumber } = getSmsConfig();

  try {
    const message = await getClient().messages.create({ to, from: fromNumber, body });
    return { providerMessageId: message.sid };
  } catch (err) {
    const code = (err as { code?: number | string; status?: number }).code;
    const status = (err as { status?: number }).status;
    const providerErrorCode = code !== undefined ? String(code) : status !== undefined ? String(status) : null;

    throw new SmsSendError(providerErrorCode);
  }
}
