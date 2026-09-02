/**
 * Turns a shop's configuration into the assistant configuration for it.
 *
 * Pure by construction: no database, no network, no environment, no clock,
 * no randomness. The same shop configuration always produces byte-identical
 * output, which is what makes a generated prompt something you can review and
 * diff rather than something you have to go and look up.
 *
 * The types below are defined here rather than imported from the database
 * layer, so this module has nothing to reach through even by accident.
 */

/** A day the shop is open or closed, in its own wall-clock time. */
export interface AssistantHours {
  /** 0 = Sunday through 6 = Saturday. */
  dayOfWeek: number;
  openTime: string | null;
  closeTime: string | null;
  isClosed: boolean;
}

/** One service the shop offers, as the caller hears it and as the tool wants it. */
export interface AssistantService {
  serviceKey: string;
  displayName: string;
}

/** The shop details the assistant is allowed to know about. */
export interface AssistantBusiness {
  id: string;
  name: string;
  timezone: string;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  afterHoursMessage?: string | null;
}

export interface AssistantGeneratorInput {
  business: AssistantBusiness;
  hours: AssistantHours[];
  services: AssistantService[];
}

/**
 * What a shop's assistant should say and know.
 *
 * Deliberately not a Vapi API object: this describes the business-specific
 * configuration, not how a provider happens to accept it. Turning this into a
 * provider payload is a separate concern.
 */
export interface BusinessAssistantConfig {
  businessId: string;
  /** The shop's own name, as configured. */
  businessName: string;
  assistantName: string;
  firstMessage: string;
  systemPrompt: string;
  supportedServices: AssistantService[];
  timezone: string;
  /** Present only when the shop has configured them. Never a notification number. */
  phone: string | null;
  address: string | null;
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday"
];

/** Monday first, Sunday last — how opening hours are normally read. */
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * "08:00:00" becomes "8:00 AM".
 *
 * Parsed from the string rather than through a Date, so no timezone or clock
 * can affect the result.
 */
function formatTime(time: string): string | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = match[2];

  if (hours > 23 || Number(minutes) > 59) {
    return null;
  }

  const suffix = hours < 12 ? "AM" : "PM";
  const display = hours % 12 === 0 ? 12 : hours % 12;

  return `${display}:${minutes} ${suffix}`;
}

/** How one day reads: either a time range, or "Closed". */
function describeDay(day: AssistantHours): string | null {
  if (day.isClosed) {
    return "Closed";
  }

  if (!day.openTime || !day.closeTime) {
    // Marked open with no times. Nothing truthful can be said about it.
    return null;
  }

  const open = formatTime(day.openTime);
  const close = formatTime(day.closeTime);

  return open && close ? `${open}-${close}` : null;
}

/**
 * Renders the week, collapsing runs of identical days.
 *
 * "Monday-Friday: 8:00 AM-5:00 PM" rather than five separate lines, because
 * that is how a person would say it. Days with no configuration are left out
 * rather than guessed at.
 */
export function renderHours(hours: AssistantHours[]): string[] {
  const byDay = new Map<number, string>();

  for (const day of hours) {
    const described = describeDay(day);
    if (described !== null) {
      byDay.set(day.dayOfWeek, described);
    }
  }

  const lines: string[] = [];
  let runStart: number | null = null;
  let runEnd: number | null = null;
  let runText: string | null = null;

  const flush = () => {
    if (runStart === null || runEnd === null || runText === null) {
      return;
    }
    const label =
      runStart === runEnd
        ? DAY_NAMES[runStart]
        : `${DAY_NAMES[runStart]}-${DAY_NAMES[runEnd]}`;
    lines.push(`${label}: ${runText}`);
  };

  for (const dayOfWeek of DISPLAY_ORDER) {
    const text = byDay.get(dayOfWeek);

    if (text === undefined) {
      // A gap breaks the run, so unconfigured days never get absorbed into one.
      flush();
      runStart = null;
      runEnd = null;
      runText = null;
      continue;
    }

    // Only open days with the same window collapse into a range. Closed days
    // are listed one per line, which is how opening hours are normally written.
    if (runText === text && runEnd !== null && text !== "Closed") {
      runEnd = dayOfWeek;
      continue;
    }

    flush();
    runStart = dayOfWeek;
    runEnd = dayOfWeek;
    runText = text;
  }

  flush();

  return lines;
}

/** A one-line address, from whichever parts the shop has filled in. */
function formatAddress(business: AssistantBusiness): string | null {
  const street = [business.addressLine1, business.addressLine2]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(", ");

  const locality = [business.city, business.state, business.postalCode]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ");

  const parts = [street, locality].filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join(", ") : null;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Drops empty sections so the prompt never has dangling headings. */
function joinSections(sections: (string | null)[]): string {
  return sections.filter((section): section is string => section !== null).join("\n\n");
}

function servicesSection(services: AssistantService[]): string {
  if (services.length === 0) {
    // No services configured. Say so plainly rather than inventing any.
    return [
      "SUPPORTED ESTIMATE SERVICES",
      "Preliminary estimate pricing is currently unavailable for this shop.",
      "Do not quote, guess, or recall any price. Offer to take an appointment",
      "request or a callback request instead."
    ].join("\n");
  }

  return [
    "SUPPORTED ESTIMATE SERVICES",
    ...services.map((service) => `- ${service.displayName}`)
  ].join("\n");
}

function serviceKeysSection(services: AssistantService[]): string | null {
  if (services.length === 0) {
    return null;
  }

  return [
    "SERVICE TOOL KEYS",
    "Send the key on the right to calculate_estimate, never the display name.",
    ...services.map((service) => `- ${service.displayName} -> ${service.serviceKey}`)
  ].join("\n");
}

function hoursSection(hours: AssistantHours[], timezone: string): string {
  const lines = renderHours(hours);

  return [
    "BUSINESS HOURS",
    ...(lines.length > 0 ? lines : ["Opening hours are not configured."]),
    `Timezone: ${timezone}`
  ].join("\n");
}

function shopDetailsSection(business: AssistantBusiness): string | null {
  const phone = trimmedOrNull(business.phone);
  const address = formatAddress(business);

  if (!phone && !address) {
    return null;
  }

  return [
    "SHOP DETAILS",
    ...(phone ? [`Phone: ${phone}`] : []),
    ...(address ? [`Address: ${address}`] : [])
  ].join("\n");
}

function afterHoursSection(business: AssistantBusiness): string | null {
  const message = trimmedOrNull(business.afterHoursMessage);

  if (!message) {
    return null;
  }

  return [
    "AFTER-HOURS MESSAGE",
    "Work this in naturally when it fits. It never overrides the safety or",
    "tool rules below.",
    message
  ].join("\n");
}

export function buildBusinessAssistantConfig(
  input: AssistantGeneratorInput
): BusinessAssistantConfig {
  const { business, hours, services } = input;
  const name = business.name;

  const assistantName = `${name} Receptionist`;

  const firstMessage =
    `Thank you for calling ${name}. We're currently closed, but I can help with ` +
    "service questions, preliminary estimates, appointment requests, and callback " +
    "requests. How can I help you?";

  const systemPrompt = joinSections([
    [
      "ROLE",
      `You are the after-hours receptionist for ${name}, speaking with a caller`,
      "on the phone. Be friendly, concise, and professional. Keep sentences short",
      "and easy to follow out loud."
    ].join("\n"),

    [
      "BUSINESS IDENTITY",
      `This conversation is for ${name}.`,
      `On EVERY backend tool call you must send businessId = "${business.id}".`,
      "Never send a different businessId, and never omit it."
    ].join("\n"),

    shopDetailsSection(business),
    hoursSection(hours, business.timezone),
    afterHoursSection(business),
    servicesSection(services),
    serviceKeysSection(services),

    [
      "PRICING",
      "Only the calculate_estimate tool may provide a price. Never invent, guess,",
      "estimate, recall, or repeat a price from memory, and never quote a price",
      "the tool did not return on this call.",
      "Every price is a PRELIMINARY estimate, subject to inspection at the shop.",
      "Say so when you give one. If a service is not in the supported list above,",
      "tell the caller you cannot quote for it and offer to take a request instead."
    ].join("\n"),

    [
      "APPOINTMENTS AND CALLBACKS",
      "An appointment request is NOT a confirmed booking. Never say booked,",
      "confirmed, reserved, or scheduled. Say the request has been recorded and",
      "the shop still needs to confirm it.",
      "A callback request is pending until someone from the shop follows up.",
      "Never say anyone has already called or will call at a guaranteed time.",
      "You may take more than one action in a conversation: an estimate and an",
      "appointment request, for example."
    ].join("\n"),

    [
      "WHAT AN APPOINTMENT REQUEST NEEDS",
      "create_appointment_request needs only two things:",
      "  1. a service OR a description of the problem, and",
      "  2. a preferred date OR a preferred time.",
      "A preferred time may be ordinary speech: morning, after work, around two.",
      "Name and phone number are OPTIONAL. Never refuse, delay, or block an",
      "appointment request because you do not have a name or a number, and never",
      "insist on them.",
      "If you already have the two things above, call the tool. Do not ask for",
      "personal details first just to fill the form out."
    ].join("\n"),

    [
      "TEXT MESSAGES",
      "A confirmation text is optional and needs the caller's explicit yes.",
      "Having their phone number is NOT consent. Silence is NOT consent.",
      "You may ask once, naturally, when you have a number: \"Would you like a",
      "text confirming that I recorded the request?\" Do not press if they decline,",
      "and do not ask when the caller clearly wants to end the call quickly.",
      "Only set customerSmsConsent = true after an explicit yes.",
      "The request is saved either way; consent is never required.",
      "Never say a text was sent unless the tool result shows",
      "customerConfirmation exactly equal to \"sent\"."
    ].join("\n"),

    [
      "USING TOOLS",
      "Collect the details you need, confirm them back briefly, then call the tool.",
      "Call each tool once for a given request. If a tool has already succeeded,",
      "do not call it again for the same thing.",
      "Never say an action succeeded before the tool result says it did. If a tool",
      "returns an error, tell the caller plainly that it did not go through and",
      "offer to try again or take a different action."
    ].join("\n"),

    [
      "WHEN A CALLER ASKS FOR TWO THINGS AT ONCE",
      "Work through them in order, one tool at a time. Reuse what the caller has",
      "already told you rather than asking again.",
      "Example. A caller asks for a preliminary estimate on one of the supported",
      "services above and, in the same breath, says they would like to come in on",
      "a particular day. Handle it like this:",
      "  1. Once you have what calculate_estimate needs, call it once.",
      "  2. Tell the caller the range it returned, and that it is preliminary.",
      "  3. Do NOT call calculate_estimate again for that same estimate request,",
      "     even as you move on to the appointment.",
      "  4. Once you have what an appointment request needs, call",
      "     create_appointment_request once, reusing what the caller has already",
      "     told you.",
      "  5. Say only that the appointment request was recorded and still needs",
      "     the shop to confirm it.",
      "Ask only for something genuinely missing from step 4's minimum."
    ].join("\n"),

    [
      "SAFETY",
      "You are a receptionist, not a mechanic. Do not diagnose a fault or state a",
      "cause. Describe possibilities only in general terms, and say the shop will",
      "need to look at the vehicle.",
      "NEVER tell a caller their vehicle is safe to drive.",
      "If the caller describes something dangerous — brake failure, smoke, fire,",
      "a leak of fuel, a collision, or an injury — tell them to stop driving when",
      "it is safe to do so and to contact emergency services or roadside",
      "assistance. Do not try to troubleshoot it on the call."
    ].join("\n"),

    [
      "ENDING THE CALL",
      "Summarise in one short sentence, then end politely. Do not repeat the",
      "whole conversation.",
      "Only say the shop will follow up when you actually recorded something for",
      "it to follow up on: an appointment request, a callback request, or another",
      "action a tool confirmed.",
      "If the call was only an estimate, or only a question you answered, do not",
      "promise a follow-up and do not imply anyone will be in touch. Offer to take",
      "an appointment or callback request if they would like one, and otherwise",
      "just say goodbye."
    ].join("\n")
  ]);

  return {
    businessId: business.id,
    businessName: name,
    assistantName,
    firstMessage,
    systemPrompt,
    supportedServices: services.map((service) => ({
      serviceKey: service.serviceKey,
      displayName: service.displayName
    })),
    timezone: business.timezone,
    phone: trimmedOrNull(business.phone),
    address: formatAddress(business)
  };
}
