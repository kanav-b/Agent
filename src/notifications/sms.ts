import { getSmsConfig, isSmsEnabled, missingSmsConfig } from "../config.js";
import { getBusiness } from "../db/businesses.js";
import {
  claimNotification,
  findBusinessName,
  findNotificationStatus,
  markNotificationFailed,
  markNotificationSent,
  type NotificationTarget,
  type NotificationType
} from "../db/notifications.js";
import { sendSms, SmsSendError } from "./twilioClient.js";
import {
  customerAppointmentMessage,
  customerCallbackMessage,
  shopAppointmentMessage,
  shopCallbackMessage,
  type AppointmentSummary,
  type CallbackSummary
} from "./messages.js";

/**
 * Sends the two kinds of message this system produces: an alert to the shop,
 * and — only when the caller asked for one — a confirmation to the caller.
 *
 * Delivery never decides whether a request is valid. A request that is stored
 * stays stored even if every message fails.
 */

/** What the tool reports back about a message. Only "sent" means it went out. */
export type DeliveryStatus =
  | "sent"
  | "failed"
  | "not_requested"
  | "no_phone"
  | "disabled"
  | "not_configured";

const PROVIDER = "twilio";

/**
 * Logs a delivery problem.
 *
 * Records only ids and the provider's code. Never the message, the number, the
 * caller's name, or anything they said.
 */
function logDeliveryFailure(
  target: NotificationTarget,
  detail: { notificationId?: string; providerErrorCode?: string | null; step: string }
): void {
  console.error(
    `[sms] type=${target.notificationType} step=${detail.step} status=FAIL ` +
      `provider=${PROVIDER} ` +
      `providerErrorCode=${JSON.stringify(detail.providerErrorCode ?? "-")} ` +
      `notificationId=${JSON.stringify(detail.notificationId ?? "-")} ` +
      `requestId=${JSON.stringify(target.appointmentRequestId ?? target.callbackRequestId ?? "-")} ` +
      `vapiCallId=${JSON.stringify(target.vapiCallId ?? "-")} ` +
      `businessId=${JSON.stringify(target.businessId)}`
  );
}

/**
 * Claims, sends, and records one message.
 *
 * The claim happens first, so a retried tool call cannot text anyone twice:
 * the second claim loses to the unique index and this reports whatever the
 * first attempt achieved instead of sending again.
 */
async function deliver(
  target: NotificationTarget,
  to: string,
  buildBody: () => Promise<string> | string
): Promise<DeliveryStatus> {
  // The switch is checked first and separately from the credentials, so
  // "we chose not to" never gets reported as "we could not". Nothing below
  // runs when SMS is off: no Twilio client, no notification row, no network.
  if (!isSmsEnabled()) {
    return "disabled";
  }

  if (missingSmsConfig().length > 0) {
    // Nothing was attempted, so say so rather than calling it a failure.
    return "not_configured";
  }

  let claim;
  try {
    claim = await claimNotification(target);
  } catch (err) {
    logDeliveryFailure(target, { step: "claim", providerErrorCode: (err as { code?: string }).code });
    return "failed";
  }

  if (!claim) {
    // Already handled, almost always a Vapi retry. Report the first outcome.
    const existing = await findNotificationStatus(target).catch(() => null);
    return existing === "sent" ? "sent" : existing === "failed" ? "failed" : "sent";
  }

  try {
    const body = await buildBody();
    const { providerMessageId } = await sendSms(to, body);
    await markNotificationSent(claim.notificationId, PROVIDER, providerMessageId);
    return "sent";
  } catch (err) {
    const providerErrorCode = err instanceof SmsSendError ? err.providerErrorCode : null;

    logDeliveryFailure(target, {
      step: "send",
      notificationId: claim.notificationId,
      providerErrorCode
    });

    // Best effort: if even the bookkeeping fails, the caller still gets a
    // truthful "failed" rather than an exception.
    await markNotificationFailed(claim.notificationId, PROVIDER, providerErrorCode).catch(() => {
      logDeliveryFailure(target, { step: "record", notificationId: claim.notificationId });
    });

    return "failed";
  }
}

export interface RequestRef {
  businessId: string;
  vapiCallId?: string;
  requestId: string;
}

function targetFor(
  kind: "appointment" | "callback",
  ref: RequestRef,
  notificationType: NotificationType,
  recipientType: "shop" | "customer"
): NotificationTarget {
  return {
    businessId: ref.businessId,
    vapiCallId: ref.vapiCallId,
    notificationType,
    recipientType,
    appointmentRequestId: kind === "appointment" ? ref.requestId : undefined,
    callbackRequestId: kind === "callback" ? ref.requestId : undefined
  };
}

export async function sendShopAppointmentNotification(
  ref: RequestRef,
  summary: AppointmentSummary
): Promise<DeliveryStatus> {
  const target = targetFor("appointment", ref, "appointment_request_shop", "shop");
  const { number, blocked } = await readShopNumber(ref.businessId);

  if (blocked || !number) {
    return blocked ?? "not_configured";
  }

  return deliver(target, number, () => shopAppointmentMessage(summary));
}

export async function sendShopCallbackNotification(
  ref: RequestRef,
  summary: CallbackSummary
): Promise<DeliveryStatus> {
  const target = targetFor("callback", ref, "callback_request_shop", "shop");
  const { number, blocked } = await readShopNumber(ref.businessId);

  if (blocked || !number) {
    return blocked ?? "not_configured";
  }

  return deliver(target, number, () => shopCallbackMessage(summary));
}

/**
 * Texts the caller about an appointment request.
 *
 * Only when they explicitly agreed on this call. A phone number on its own is
 * never treated as permission.
 */
export async function sendCustomerAppointmentConfirmation(
  ref: RequestRef,
  summary: AppointmentSummary,
  consent: boolean
): Promise<DeliveryStatus> {
  if (!consent) {
    return "not_requested";
  }

  if (!summary.customerPhone) {
    return "no_phone";
  }

  const target = targetFor("appointment", ref, "appointment_request_customer", "customer");

  return deliver(target, summary.customerPhone, async () =>
    customerAppointmentMessage(await shopName(ref.businessId), summary)
  );
}

export async function sendCustomerCallbackConfirmation(
  ref: RequestRef,
  summary: CallbackSummary,
  consent: boolean
): Promise<DeliveryStatus> {
  if (!consent) {
    return "not_requested";
  }

  if (!summary.customerPhone) {
    return "no_phone";
  }

  const target = targetFor("callback", ref, "callback_request_customer", "customer");

  return deliver(target, summary.customerPhone, async () =>
    customerCallbackMessage(await shopName(ref.businessId), summary)
  );
}

/**
 * Where this shop's alerts go, or the reason none can be sent.
 *
 * Precedence, most specific first:
 *
 *   1. the shop's own `businesses.notification_phone`
 *   2. the global `SHOP_NOTIFICATION_NUMBER` fallback
 *
 * With neither, there is nowhere to send to, which is reported as
 * "not_configured" rather than as a failure. Returns a reason instead of
 * throwing so a switched-off install describes itself accurately.
 */
async function readShopNumber(
  businessId: string
): Promise<{ number?: string; blocked?: DeliveryStatus }> {
  if (!isSmsEnabled()) {
    return { blocked: "disabled" };
  }

  if (missingSmsConfig().length > 0) {
    return { blocked: "not_configured" };
  }

  const business = await getBusiness(businessId).catch(() => null);
  const number = business?.notificationPhone ?? getSmsConfig().shopNotificationNumber;

  return number ? { number } : { blocked: "not_configured" };
}

/** The shop's name for caller-facing text, falling back to its id. */
async function shopName(businessId: string): Promise<string> {
  const name = await findBusinessName(businessId).catch(() => null);
  return name ?? businessId;
}
