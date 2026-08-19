import { describe, expect, it } from "vitest";
import { classifyOutcome, normalizeEndOfCall } from "./normalize.js";
import type { VapiEventMessage } from "../schemas/vapiEvents.js";

/** A realistic end-of-call report, with pieces overridable per test. */
function report(overrides: Record<string, unknown> = {}): VapiEventMessage {
  return {
    type: "end-of-call-report",
    call: {
      id: "vapi-call-1",
      createdAt: "2026-08-19T10:00:00.000Z",
      endedAt: "2026-08-19T10:04:30.000Z",
      customer: { number: "+14085551234" }
    },
    endedReason: "customer-ended-call",
    artifact: { transcript: "User: Hi\nAssistant: Hello" },
    analysis: { summary: "Caller asked about brakes." },
    ...overrides
  } as VapiEventMessage;
}

describe("normalizeEndOfCall", () => {
  it("pulls out the call id, phone, times, reason, transcript, and summary", () => {
    expect(normalizeEndOfCall(report())).toEqual({
      vapiCallId: "vapi-call-1",
      businessId: "demo-shop",
      callerPhone: "+14085551234",
      customerName: null,
      startedAt: "2026-08-19T10:00:00.000Z",
      endedAt: "2026-08-19T10:04:30.000Z",
      endedReason: "customer-ended-call",
      transcript: "User: Hi\nAssistant: Hello",
      summary: "Caller asked about brakes."
    });
  });

  it("prefers startedAt over createdAt when both exist", () => {
    const data = normalizeEndOfCall(
      report({
        call: {
          id: "c",
          createdAt: "2026-08-19T10:00:00.000Z",
          startedAt: "2026-08-19T10:00:07.000Z"
        }
      })
    );

    expect(data.startedAt).toBe("2026-08-19T10:00:07.000Z");
  });

  it("defaults the business to demo-shop", () => {
    expect(normalizeEndOfCall(report()).businessId).toBe("demo-shop");
  });

  it("uses a businessId from call metadata when present", () => {
    const data = normalizeEndOfCall(
      report({ call: { id: "c", metadata: { businessId: "other-shop" } } })
    );

    expect(data.businessId).toBe("other-shop");
  });

  it("reads the caller from message.customer when the call has none", () => {
    const data = normalizeEndOfCall(
      report({ call: { id: "c" }, customer: { number: "+14085559999", name: "Dana" } })
    );

    expect(data.callerPhone).toBe("+14085559999");
    expect(data.customerName).toBe("Dana");
  });

  it("leaves the phone null rather than inventing one", () => {
    const data = normalizeEndOfCall(report({ call: { id: "c" }, customer: undefined }));

    expect(data.callerPhone).toBeNull();
    expect(data.customerName).toBeNull();
  });

  it("survives a payload with nothing optional in it", () => {
    const data = normalizeEndOfCall({ type: "end-of-call-report", call: { id: "bare" } } as VapiEventMessage);

    expect(data.vapiCallId).toBe("bare");
    expect(data.startedAt).toBeNull();
    expect(data.endedAt).toBeNull();
    expect(data.endedReason).toBeNull();
    expect(data.transcript).toBeNull();
    expect(data.summary).toBeNull();
  });

  it("ignores an unparseable timestamp", () => {
    const data = normalizeEndOfCall(report({ call: { id: "c", createdAt: "not a date" } }));

    expect(data.startedAt).toBeNull();
  });
});

describe("transcript handling", () => {
  it("builds a transcript from messages when there is no artifact transcript", () => {
    const data = normalizeEndOfCall(
      report({
        artifact: {
          messages: [
            { role: "system", message: "You are a receptionist." },
            { role: "assistant", message: "How can I help?" },
            { role: "user", message: "Brake pads please." }
          ]
        }
      })
    );

    expect(data.transcript).toBe("Assistant: How can I help?\nUser: Brake pads please.");
  });

  it("leaves out system and tool messages entirely", () => {
    const data = normalizeEndOfCall(
      report({
        artifact: {
          messages: [
            { role: "system", message: "secret system prompt" },
            { role: "tool_calls", message: '{"secret":"do-not-store"}' },
            { role: "user", message: "Hello" }
          ]
        }
      })
    );

    expect(data.transcript).toBe("User: Hello");
    expect(data.transcript).not.toContain("secret");
  });

  it("prefers the artifact transcript over the message list", () => {
    const data = normalizeEndOfCall(
      report({
        artifact: {
          transcript: "the real transcript",
          messages: [{ role: "user", message: "ignored" }]
        }
      })
    );

    expect(data.transcript).toBe("the real transcript");
  });

  it("stores null when there is no transcript at all", () => {
    expect(normalizeEndOfCall(report({ artifact: undefined })).transcript).toBeNull();
  });

  it("stores null when the message list has nothing usable", () => {
    const data = normalizeEndOfCall(report({ artifact: { messages: [{ role: "system", message: "x" }] } }));

    expect(data.transcript).toBeNull();
  });
});

describe("summary handling", () => {
  it("stores the summary Vapi provides", () => {
    expect(normalizeEndOfCall(report()).summary).toBe("Caller asked about brakes.");
  });

  it("stores null when Vapi provides no analysis", () => {
    expect(normalizeEndOfCall(report({ analysis: undefined })).summary).toBeNull();
  });

  it("treats a blank summary as no summary", () => {
    expect(normalizeEndOfCall(report({ analysis: { summary: "   " } })).summary).toBeNull();
  });
});

describe("classifyOutcome", () => {
  const base = normalizeEndOfCall(report());

  it("is estimate_provided when the call produced an estimate", () => {
    expect(classifyOutcome(base, { estimateProvided: true })).toEqual({
      outcome: "estimate_provided",
      requiresFollowUp: false
    });
  });

  it("is unresolved and needs follow-up when the call broke", () => {
    const broken = { ...base, endedReason: "pipeline-error-openai-llm-failed" };

    expect(classifyOutcome(broken, { estimateProvided: false })).toEqual({
      outcome: "unresolved",
      requiresFollowUp: true
    });
  });

  it("treats a silence timeout as unresolved", () => {
    const quiet = { ...base, endedReason: "silence-timed-out" };

    expect(classifyOutcome(quiet, { estimateProvided: false }).outcome).toBe("unresolved");
  });

  it("does not treat a normal hangup as a failure", () => {
    expect(classifyOutcome(base, { estimateProvided: false }).outcome).not.toBe("unresolved");
  });

  it("is callback_requested when the caller explicitly asks to be rung back", () => {
    const callback = { ...base, transcript: "User: Can you have someone call me back tomorrow?" };

    expect(classifyOutcome(callback, { estimateProvided: false })).toEqual({
      outcome: "callback_requested",
      requiresFollowUp: true
    });
  });

  it("is information_only for an ordinary conversation", () => {
    expect(classifyOutcome(base, { estimateProvided: false })).toEqual({
      outcome: "information_only",
      requiresFollowUp: false
    });
  });

  it("is unknown when there is nothing to go on", () => {
    const empty = { ...base, transcript: null, summary: null, endedReason: null };

    expect(classifyOutcome(empty, { estimateProvided: false })).toEqual({
      outcome: "unknown",
      requiresFollowUp: false
    });
  });

  it("lets a stored estimate outrank the callback phrase", () => {
    const both = { ...base, transcript: "User: call me back" };

    expect(classifyOutcome(both, { estimateProvided: true }).outcome).toBe("estimate_provided");
  });
});
