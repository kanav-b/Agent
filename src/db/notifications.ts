import { getSupabase } from "./supabase.js";

/**
 * Queries for the notification log.
 *
 * The table records that a message was attempted and how it went — never the
 * message itself and never a phone number. Nothing in this file logs a row's
 * contents.
 */

export type NotificationType =
  | "appointment_request_shop"
  | "appointment_request_customer"
  | "callback_request_shop"
  | "callback_request_customer";

export type RecipientType = "shop" | "customer";
export type NotificationStatus = "pending" | "sent" | "failed";

export class NotificationError extends Error {
  readonly step: string;
  readonly code?: string;

  constructor(step: string, message: string, code?: string) {
    super(message);
    this.name = "NotificationError";
    this.step = step;
    this.code = code;
  }
}

/** Postgres unique-violation code, raised when two claims collide. */
const UNIQUE_VIOLATION = "23505";

export interface NotificationTarget {
  businessId: string;
  notificationType: NotificationType;
  recipientType: RecipientType;
  vapiCallId?: string;
  appointmentRequestId?: string;
  callbackRequestId?: string;
}

export interface Claim {
  /** The row to update once the send has been attempted. */
  notificationId: string;
}

/**
 * Reserves the right to send one notification.
 *
 * Writing the 'pending' row *before* contacting Twilio is what makes retries
 * safe: the unique index rejects a second claim for the same request and
 * notification type, so the duplicate never gets as far as sending. Returns
 * null when somebody already claimed it.
 */
export async function claimNotification(target: NotificationTarget): Promise<Claim | null> {
  const { data, error } = await getSupabase()
    .from("notifications")
    .insert({
      business_id: target.businessId,
      vapi_call_id: target.vapiCallId ?? null,
      appointment_request_id: target.appointmentRequestId ?? null,
      callback_request_id: target.callbackRequestId ?? null,
      recipient_type: target.recipientType,
      channel: "sms",
      notification_type: target.notificationType
      // status defaults to 'pending' until the send is attempted.
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      return null;
    }
    throw new NotificationError("claimNotification", error.message, error.code);
  }

  if (!data) {
    throw new NotificationError("claimNotification", "Insert returned no row.");
  }

  return { notificationId: data.id as string };
}

/** How an already-claimed notification turned out, for reporting on a retry. */
export async function findNotificationStatus(
  target: Pick<
    NotificationTarget,
    "notificationType" | "appointmentRequestId" | "callbackRequestId"
  >
): Promise<NotificationStatus | null> {
  const column = target.appointmentRequestId ? "appointment_request_id" : "callback_request_id";
  const value = target.appointmentRequestId ?? target.callbackRequestId;

  if (!value) {
    return null;
  }

  const { data, error } = await getSupabase()
    .from("notifications")
    .select("status")
    .eq(column, value)
    .eq("notification_type", target.notificationType)
    .maybeSingle();

  if (error) {
    throw new NotificationError("findNotificationStatus", error.message, error.code);
  }

  return data ? (data.status as NotificationStatus) : null;
}

/** Records that the provider accepted the message. */
export async function markNotificationSent(
  notificationId: string,
  provider: string,
  providerMessageId: string
): Promise<void> {
  const { error } = await getSupabase()
    .from("notifications")
    .update({
      status: "sent",
      provider,
      provider_message_id: providerMessageId,
      sent_at: new Date().toISOString()
    })
    .eq("id", notificationId);

  if (error) {
    throw new NotificationError("markNotificationSent", error.message, error.code);
  }
}

/**
 * Records that the provider rejected the message.
 *
 * Only the provider's own error code is kept — never the exception, the
 * message body, or anything from the request.
 */
export async function markNotificationFailed(
  notificationId: string,
  provider: string,
  errorCode: string | null
): Promise<void> {
  const { error } = await getSupabase()
    .from("notifications")
    .update({ status: "failed", provider, error_code: errorCode })
    .eq("id", notificationId);

  if (error) {
    throw new NotificationError("markNotificationFailed", error.message, error.code);
  }
}

/** The shop's display name, used when texting a caller. */
export async function findBusinessName(businessId: string): Promise<string | null> {
  const { data, error } = await getSupabase()
    .from("businesses")
    .select("name")
    .eq("id", businessId)
    .maybeSingle();

  if (error) {
    throw new NotificationError("findBusinessName", error.message, error.code);
  }

  return data ? ((data.name as string | null) ?? null) : null;
}
