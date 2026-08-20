/**
 * The exact wording of every message this system sends.
 *
 * Kept in one place so the promises made to a caller can be checked at a
 * glance. Two rules run through all of it:
 *
 *  - nothing is ever described as booked, confirmed, reserved, or guaranteed
 *  - a caller-facing message says plainly that the request is not confirmed
 *
 * Messages never contain a transcript, a secret, or anything beyond the few
 * fields named below.
 */

export interface AppointmentSummary {
  vehicleYear?: number | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  service?: string | null;
  problemDescription?: string | null;
  preferredDate?: string | null;
  preferredTimeText?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
}

export interface CallbackSummary {
  reason?: string | null;
  preferredCallbackAt?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
}

/** Joins the parts that are actually present, so no message has empty gaps. */
function sentence(parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(" ");
}

function vehicleText(summary: AppointmentSummary): string | null {
  const parts = [summary.vehicleYear, summary.vehicleMake, summary.vehicleModel].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

function preferredText(summary: AppointmentSummary): string | null {
  const parts = [summary.preferredDate, summary.preferredTimeText].filter(Boolean);
  return parts.length > 0 ? `Preferred: ${parts.join(" ")}.` : null;
}

/**
 * The caller's details, for the shop only.
 *
 * The shop is the intended recipient and needs to be able to ring them back,
 * so a name and number are appropriate here — and nowhere else.
 */
function callerText(name?: string | null, phone?: string | null): string | null {
  const parts = [name, phone].filter(Boolean);
  return parts.length > 0 ? `Caller: ${parts.join(" ")}.` : null;
}

export function shopAppointmentMessage(summary: AppointmentSummary): string {
  return sentence([
    "New appointment request.",
    vehicleText(summary) ? `${vehicleText(summary)}.` : null,
    summary.service ? `Service: ${summary.service}.` : null,
    summary.problemDescription ? `Issue: ${summary.problemDescription}.` : null,
    preferredText(summary),
    callerText(summary.customerName, summary.customerPhone),
    "Pending — check the receptionist system for details."
  ]);
}

export function shopCallbackMessage(summary: CallbackSummary): string {
  return sentence([
    "New callback request.",
    summary.reason ? `Reason: ${summary.reason}.` : null,
    summary.preferredCallbackAt ? `Preferred: ${summary.preferredCallbackAt}.` : null,
    callerText(summary.customerName, summary.customerPhone),
    "Pending — check the receptionist system for details."
  ]);
}

/**
 * Caller-facing appointment text.
 *
 * States that this is not a confirmed appointment, in those words.
 */
export function customerAppointmentMessage(
  shopName: string,
  summary: AppointmentSummary
): string {
  const when = [summary.preferredDate, summary.preferredTimeText].filter(Boolean).join(" ");

  return sentence([
    `${shopName}:`,
    when ? `We received your appointment request for ${when}.` : "We received your appointment request.",
    "This is not a confirmed appointment.",
    "The shop will follow up to confirm."
  ]);
}

/**
 * Caller-facing callback text.
 *
 * A preferred time is repeated back as a preference only — never as a promise
 * that somebody will ring at that moment.
 */
export function customerCallbackMessage(shopName: string, summary: CallbackSummary): string {
  return sentence([
    `${shopName}:`,
    "We received your callback request.",
    "It is pending until someone from the shop follows up.",
    summary.preferredCallbackAt
      ? `You asked for ${summary.preferredCallbackAt}; that is noted as a preference, not a guaranteed time.`
      : null
  ]);
}
