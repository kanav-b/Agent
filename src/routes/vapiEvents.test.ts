import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// The database is stubbed: these tests never reach the network.
vi.mock("../db/calls.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/calls.js")>();
  return {
    ...actual,
    persistCall: vi.fn(),
    findEstimatesForCall: vi.fn()
  };
});
vi.mock("../db/estimates.js", () => ({ persistEstimate: vi.fn() }));
vi.mock("../db/requests.js", () => ({
  hasRequestForCall: vi.fn(),
  linkRequestsToCustomer: vi.fn(),
  logRequestFailure: vi.fn()
}));

import { createApp } from "../app.js";
import { findEstimatesForCall, persistCall } from "../db/calls.js";
import { hasRequestForCall, linkRequestsToCustomer } from "../db/requests.js";
import { VAPI_SECRET_HEADER } from "../middleware/vapiAuth.js";

const mockPersistCall = vi.mocked(persistCall);
const mockFindEstimates = vi.mocked(findEstimatesForCall);
const mockHasRequest = vi.mocked(hasRequestForCall);
const mockLinkRequests = vi.mocked(linkRequestsToCustomer);

const TEST_SECRET = "test-vapi-secret-not-real";
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = TEST_SECRET;

const app = createApp();
const ROUTE = "/api/vapi/events";

/** Posts an authenticated event. */
const postEvent = (body: object) =>
  request(app).post(ROUTE).set(VAPI_SECRET_HEADER, TEST_SECRET).send(body);

function endOfCall(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      type: "end-of-call-report",
      call: {
        id: "vapi-call-1",
        createdAt: "2026-08-19T10:00:00.000Z",
        endedAt: "2026-08-19T10:04:30.000Z",
        customer: { number: "+14085551234" }
      },
      endedReason: "customer-ended-call",
      artifact: { transcript: "User: Hi\nAssistant: Hello" },
      analysis: { summary: "Asked about brakes." },
      ...overrides
    }
  };
}

const persistedCall = () => mockPersistCall.mock.calls[0][0];

beforeEach(() => {
  mockPersistCall.mockReset();
  mockPersistCall.mockResolvedValue({ duplicate: false, customerId: "customer-1" });
  mockFindEstimates.mockReset();
  mockFindEstimates.mockResolvedValue([]);
  mockHasRequest.mockReset();
  mockHasRequest.mockResolvedValue(false);
  mockLinkRequests.mockReset();
  mockLinkRequests.mockResolvedValue(undefined);
});

describe("POST /api/vapi/events — end-of-call report", () => {
  it("accepts a valid report", async () => {
    const res = await postEvent(endOfCall());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(mockPersistCall).toHaveBeenCalledTimes(1);
  });

  it("persists the Vapi call id", async () => {
    await postEvent(endOfCall());

    expect(persistedCall().vapiCallId).toBe("vapi-call-1");
  });

  it("persists the caller phone number", async () => {
    await postEvent(endOfCall());

    expect(persistedCall().callerPhone).toBe("+14085551234");
  });

  it("persists the transcript", async () => {
    await postEvent(endOfCall());

    expect(persistedCall().transcript).toBe("User: Hi\nAssistant: Hello");
  });

  it("persists the summary when Vapi provides one", async () => {
    await postEvent(endOfCall());

    expect(persistedCall().summary).toBe("Asked about brakes.");
  });

  it("stores null when there is no transcript", async () => {
    await postEvent(endOfCall({ artifact: undefined }));

    expect(persistedCall().transcript).toBeNull();
  });

  it("stores null when there is no summary", async () => {
    await postEvent(endOfCall({ analysis: undefined }));

    expect(persistedCall().summary).toBeNull();
  });

  it("leaves the phone null when the call has no customer", async () => {
    await postEvent(endOfCall({ call: { id: "vapi-call-1" } }));

    expect(persistedCall().callerPhone).toBeNull();
  });

  it("records estimate_provided when the call produced an estimate", async () => {
    mockFindEstimates.mockResolvedValue(["estimate-1"]);

    await postEvent(endOfCall());

    expect(persistedCall().outcome).toBe("estimate_provided");
    expect(persistedCall().requiresFollowUp).toBe(false);
  });

  it("records unresolved and follow-up when the call broke", async () => {
    await postEvent(endOfCall({ endedReason: "pipeline-error-openai-llm-failed" }));

    expect(persistedCall().outcome).toBe("unresolved");
    expect(persistedCall().requiresFollowUp).toBe(true);
  });

  it("still returns ok for a repeated report", async () => {
    mockPersistCall.mockResolvedValue({ duplicate: true, customerId: "customer-1" });

    const res = await postEvent(endOfCall());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("does not persist twice for the same report sent twice", async () => {
    await postEvent(endOfCall());
    mockPersistCall.mockResolvedValue({ duplicate: true, customerId: "customer-1" });
    await postEvent(endOfCall());

    // Both requests are handled, and both target the same Vapi call id, which
    // the unique constraint collapses into one row.
    expect(mockPersistCall.mock.calls.every((c) => c[0].vapiCallId === "vapi-call-1")).toBe(true);
  });
});

describe("POST /api/vapi/events — other event types", () => {
  it("ignores an unsupported event", async () => {
    const res = await postEvent({ message: { type: "status-update", status: "in-progress" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ignored" });
  });

  it("persists nothing for an unsupported event", async () => {
    await postEvent({ message: { type: "transcript", transcript: "hello" } });

    expect(mockPersistCall).not.toHaveBeenCalled();
  });

  it("ignores a conversation update without a call object", async () => {
    const res = await postEvent({ message: { type: "conversation-update" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ignored" });
  });
});

describe("POST /api/vapi/events — malformed input", () => {
  it("rejects a body with no message", async () => {
    const res = await postEvent({ nonsense: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid Vapi event body." });
    expect(mockPersistCall).not.toHaveBeenCalled();
  });

  it("rejects a message with no type", async () => {
    const res = await postEvent({ message: { call: { id: "x" } } });

    expect(res.status).toBe(400);
    expect(mockPersistCall).not.toHaveBeenCalled();
  });

  it("rejects an end-of-call report with no call id", async () => {
    const res = await postEvent({ message: { type: "end-of-call-report" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing a call id/);
    expect(mockPersistCall).not.toHaveBeenCalled();
  });

  it("returns safe JSON for malformed JSON", async () => {
    const res = await request(app)
      .post(ROUTE)
      .set(VAPI_SECRET_HEADER, TEST_SECRET)
      .set("Content-Type", "application/json")
      .send("{bad json");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid JSON request body." });
    expect(res.text).not.toMatch(/<html|node_modules|\/Users\//);
  });
});

describe("POST /api/vapi/events — persistence failure", () => {
  it("returns a safe 500 so Vapi retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockPersistCall.mockRejectedValue(new Error("connection refused"));

    const res = await postEvent(endOfCall());

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Could not save the call. Please retry." });
  });

  it("leaks no database detail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockPersistCall.mockRejectedValue(new Error("password=hunter2 at /src/db/calls.ts:42"));

    const res = await postEvent(endOfCall());

    expect(res.text).not.toMatch(/hunter2|\.ts:|node_modules/);
  });

  it("logs no personal information when persistence fails", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => {
      logged.push(String(msg));
    });
    mockPersistCall.mockRejectedValue(new Error("connection refused"));

    await postEvent(endOfCall());

    const output = logged.join("\n");
    expect(output).toContain("vapiCallId=");
    expect(output).not.toContain("+14085551234");
    expect(output).not.toContain("User: Hi");
    expect(output).not.toContain("Asked about brakes");
  });
});

describe("POST /api/vapi/events — authentication", () => {
  it("returns 401 without the header", async () => {
    const res = await request(app).post(ROUTE).send(endOfCall());

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized." });
  });

  it("returns 401 with the wrong secret", async () => {
    const res = await request(app)
      .post(ROUTE)
      .set(VAPI_SECRET_HEADER, "wrong-secret")
      .send(endOfCall());

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized." });
  });

  it("persists nothing for an unauthorised event", async () => {
    await request(app).post(ROUTE).send(endOfCall());

    expect(mockPersistCall).not.toHaveBeenCalled();
    expect(mockFindEstimates).not.toHaveBeenCalled();
  });
});

describe("POST /api/vapi/events — structured requests decide the outcome", () => {
  it("records callback_requested when a callback row exists", async () => {
    mockHasRequest.mockImplementation(async (kind) => kind === "callback");

    await postEvent(endOfCall());

    expect(persistedCall().outcome).toBe("callback_requested");
    expect(persistedCall().requiresFollowUp).toBe(true);
  });

  it("records appointment_requested when an appointment row exists", async () => {
    mockHasRequest.mockImplementation(async (kind) => kind === "appointment");

    await postEvent(endOfCall());

    expect(persistedCall().outcome).toBe("appointment_requested");
    expect(persistedCall().requiresFollowUp).toBe(true);
  });

  it("lets an estimate outrank both request kinds", async () => {
    mockFindEstimates.mockResolvedValue(["estimate-1"]);
    mockHasRequest.mockResolvedValue(true);

    await postEvent(endOfCall());

    expect(persistedCall().outcome).toBe("estimate_provided");
  });

  it("puts a callback request ahead of an appointment request", async () => {
    mockHasRequest.mockResolvedValue(true);

    await postEvent(endOfCall());

    expect(persistedCall().outcome).toBe("callback_requested");
  });

  it("puts a structured request ahead of a broken call", async () => {
    mockHasRequest.mockImplementation(async (kind) => kind === "appointment");

    await postEvent(endOfCall({ endedReason: "pipeline-error-openai-llm-failed" }));

    expect(persistedCall().outcome).toBe("appointment_requested");
  });

  it("still falls back to the phrase heuristic when no request row exists", async () => {
    await postEvent(
      endOfCall({ artifact: { transcript: "User: please have someone call me back" } })
    );

    expect(persistedCall().outcome).toBe("callback_requested");
  });
});

describe("POST /api/vapi/events — backfilling the caller onto requests", () => {
  it("links requests to the resolved customer", async () => {
    await postEvent(endOfCall());

    expect(mockLinkRequests).toHaveBeenCalledWith("vapi-call-1", "customer-1");
  });

  it("does not try to link when no customer could be resolved", async () => {
    mockPersistCall.mockResolvedValue({ duplicate: false, customerId: null });

    await postEvent(endOfCall());

    expect(mockLinkRequests).not.toHaveBeenCalled();
  });

  it("returns 500 when the backfill fails, so Vapi retries", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockLinkRequests.mockRejectedValue(new Error("connection refused"));

    const res = await postEvent(endOfCall());

    expect(res.status).toBe(500);
  });
});

