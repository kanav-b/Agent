import { DEFAULT_BUSINESS_ID } from "../schemas/estimate.js";
import type { VapiEventMessage } from "../schemas/vapiEvents.js";

/**
 * Turns a Vapi end-of-call report into the flat set of fields we store.
 *
 * Vapi's payload varies by call type and version, so every read here tolerates
 * a missing field. Nothing is invented: anything absent becomes null.
 */

export const CALL_OUTCOMES = [
  "estimate_provided",
  "callback_requested",
  "information_only",
  "unresolved",
  "unknown"
] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** The fields we can read straight off the payload. */
export interface NormalizedCallData {
  vapiCallId: string;
  businessId: string;
  callerPhone: string | null;
  customerName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  transcript: string | null;
  summary: string | null;
}

/** The full record, once the outcome has been worked out. */
export interface NormalizedCall extends NormalizedCallData {
  outcome: CallOutcome;
  requiresFollowUp: boolean;
}

/** Accepts a date only if it actually parses; anything else becomes null. */
function toTimestamp(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Which shop the call belongs to.
 *
 * Vapi can carry arbitrary metadata on a call, so a businessId set there wins.
 * Otherwise every call belongs to the demo shop — multi-business routing is
 * not part of this phase.
 */
function readBusinessId(message: VapiEventMessage): string {
  const fromMetadata =
    message.call?.metadata?.businessId ?? message.call?.assistantOverrides?.metadata?.businessId;

  return typeof fromMetadata === "string" && fromMetadata.trim()
    ? fromMetadata.trim()
    : DEFAULT_BUSINESS_ID;
}

/**
 * Builds a readable transcript from the message list.
 *
 * Only what the two humans-in-the-conversation said: system prompts and tool
 * payloads are skipped, so no arguments, secrets, or headers can end up in the
 * stored text.
 */
function transcriptFromMessages(message: VapiEventMessage): string | null {
  const messages = message.artifact?.messages;

  if (!messages || messages.length === 0) {
    return null;
  }

  const spoken = messages
    .filter((entry) => entry.role === "user" || entry.role === "assistant" || entry.role === "bot")
    .map((entry) => {
      const text = trimmedOrNull(entry.message ?? entry.content);
      if (!text) {
        return null;
      }
      const speaker = entry.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${text}`;
    })
    .filter((line): line is string => line !== null);

  return spoken.length > 0 ? spoken.join("\n") : null;
}

/** Vapi's own transcript if there is one, otherwise one built from the messages. */
function readTranscript(message: VapiEventMessage): string | null {
  return trimmedOrNull(message.artifact?.transcript) ?? transcriptFromMessages(message);
}

export function normalizeEndOfCall(message: VapiEventMessage): NormalizedCallData {
  const call = message.call;
  const customer = call?.customer ?? message.customer;

  return {
    vapiCallId: call?.id as string,
    businessId: readBusinessId(message),
    callerPhone: trimmedOrNull(customer?.number),
    customerName: trimmedOrNull(customer?.name),
    startedAt: toTimestamp(call?.startedAt ?? call?.createdAt ?? message.startedAt),
    endedAt: toTimestamp(call?.endedAt ?? message.endedAt),
    endedReason: trimmedOrNull(message.endedReason),
    transcript: readTranscript(message),
    // Vapi's post-call analysis, when it is configured. We never generate one.
    summary: trimmedOrNull(message.analysis?.summary)
  };
}

/**
 * Ended reasons that mean the call broke rather than finished.
 *
 * Vapi has a long, provider-specific list, so this matches the shapes those
 * names share instead of enumerating them.
 */
const FAILURE_REASON_PATTERN =
  /error|failed|timed-out|worker-died|not-valid|not-found|quota-exceeded|exceeded-max-duration/i;

/**
 * Phrases that only really appear when someone asks to be rung back.
 *
 * Kept deliberately short and literal. This is the one judgement call in the
 * classifier, so it errs towards missing a callback rather than inventing one.
 */
const CALLBACK_PHRASES = [
  "call me back",
  "call me tomorrow",
  "give me a call",
  "give me a ring",
  "have someone call me",
  "someone call me back",
  "ring me back"
];

function mentionsCallback(text: string | null): boolean {
  if (!text) {
    return false;
  }

  const lowered = text.toLowerCase();
  return CALLBACK_PHRASES.some((phrase) => lowered.includes(phrase));
}

/**
 * Works out what the call amounted to, using only facts we are sure of.
 *
 * The order matters. A stored estimate is hard evidence and outranks anything
 * read out of text; a broken call is next; the text heuristic is last and only
 * fires on an explicit phrase. Anything else with no transcript is "unknown"
 * rather than a guess.
 */
export function classifyOutcome(
  data: NormalizedCallData,
  options: { estimateProvided: boolean }
): { outcome: CallOutcome; requiresFollowUp: boolean } {
  if (options.estimateProvided) {
    return { outcome: "estimate_provided", requiresFollowUp: false };
  }

  if (data.endedReason && FAILURE_REASON_PATTERN.test(data.endedReason)) {
    // The call broke, so nobody can be sure the caller got what they needed.
    return { outcome: "unresolved", requiresFollowUp: true };
  }

  if (mentionsCallback(data.transcript) || mentionsCallback(data.summary)) {
    return { outcome: "callback_requested", requiresFollowUp: true };
  }

  if (data.transcript) {
    return { outcome: "information_only", requiresFollowUp: false };
  }

  return { outcome: "unknown", requiresFollowUp: false };
}
