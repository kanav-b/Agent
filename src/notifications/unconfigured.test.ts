import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * The whole app with SMS switched on but Twilio deliberately not set up.
 *
 * SMS is an optional extra: everything else must keep working, nothing may
 * reach Twilio, and the tool results must say plainly that no message was
 * attempted.
 */

// Blank rather than deleted: an empty value still counts as "already set", so
// loading a real .env cannot put Twilio settings back and make this pass by
// accident.
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = "test-vapi-secret-not-real";
// Switched on, but with no credentials: the "enabled but unusable" case.
process.env.SMS_ENABLED = "true";
process.env.TWILIO_ACCOUNT_SID = "";
process.env.TWILIO_AUTH_TOKEN = "";
process.env.TWILIO_FROM_NUMBER = "";
process.env.SHOP_NOTIFICATION_NUMBER = "";

// Twilio is left real except for the one function that would reach the
// network, so any attempt to send is caught by the assertions below.
vi.mock("./twilioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./twilioClient.js")>();
  return { ...actual, sendSms: vi.fn() };
});

// The database is stubbed; this is about SMS, not persistence.
vi.mock("../db/requests.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/requests.js")>();
  return {
    ...actual,
    createAppointmentRequest: vi.fn(),
    createCallbackRequest: vi.fn(),
    hasRequestForCall: vi.fn(),
    linkRequestsToCustomer: vi.fn()
  };
});
vi.mock("../db/estimates.js", () => ({ persistEstimate: vi.fn() }));
vi.mock("../db/calls.js", () => ({
  persistCall: vi.fn(),
  findEstimatesForCall: vi.fn(),
  logCallFailure: vi.fn()
}));
vi.mock("../db/notifications.js", () => ({
  claimNotification: vi.fn(),
  findNotificationStatus: vi.fn(),
  markNotificationSent: vi.fn(),
  markNotificationFailed: vi.fn(),
  findBusinessName: vi.fn()
}));

import { createApp } from "../app.js";
import { missingSmsConfig } from "../config.js";
import { sendSms } from "./twilioClient.js";
import { claimNotification } from "../db/notifications.js";
import { createAppointmentRequest, createCallbackRequest, hasRequestForCall } from "../db/requests.js";
import { persistEstimate } from "../db/estimates.js";
import { findEstimatesForCall, persistCall } from "../db/calls.js";
import { VAPI_SECRET_HEADER } from "../middleware/vapiAuth.js";

const mockSendSms = vi.mocked(sendSms);
const mockClaim = vi.mocked(claimNotification);
const mockAppointment = vi.mocked(createAppointmentRequest);
const mockCallback = vi.mocked(createCallbackRequest);
const mockPersistEstimate = vi.mocked(persistEstimate);

const TEST_SECRET = "test-vapi-secret-not-real";
const vehicle = { year: 2019, make: "Toyota", model: "Camry" };

// The app is built here: if startup needed Twilio, this would fail.
const app = createApp();

const post = (route: string, body: object) =>
  request(app).post(route).set(VAPI_SECRET_HEADER, TEST_SECRET).send(body);

function envelope(name: string, args: Record<string, unknown>, id = "tc-1") {
  return { message: { type: "tool-calls", toolCallList: [{ id, function: { name, arguments: args } }] } };
}

const appointmentArgs = {
  customer: { name: "Dana", phone: "+14085551234" },
  service: "front_brake_pads",
  preferredDate: "2026-08-25"
};

const callbackArgs = {
  customer: { name: "Dana", phone: "+14085551234" },
  reason: "brake question"
};

const parsedResult = (res: { body: { results: { result: string }[] } }) =>
  JSON.parse(res.body.results[0].result);

beforeEach(() => {
  vi.clearAllMocks();
  mockAppointment.mockResolvedValue({ requestId: "appointment-1", reused: false });
  mockCallback.mockResolvedValue({ requestId: "callback-1", reused: false });
  mockPersistEstimate.mockImplementation(async (input) => ({
    estimateId: input.estimateId,
    reused: false
  }));
  vi.mocked(persistCall).mockResolvedValue({ duplicate: false, customerId: null });
  vi.mocked(findEstimatesForCall).mockResolvedValue([]);
  vi.mocked(hasRequestForCall).mockResolvedValue(false);
});

describe("the app runs without Twilio configured", () => {
  it("knows SMS is not configured", () => {
    expect(missingSmsConfig()).toEqual([
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_FROM_NUMBER",
      "SHOP_NOTIFICATION_NUMBER"
    ]);
  });

  it("builds the app and answers /health", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("still prices and stores an estimate", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(200);
    expect(res.body.low).toBe(300);
    expect(res.body.high).toBe(450);
    expect(mockPersistEstimate).toHaveBeenCalledTimes(1);
  });

  it("still answers the estimate tool", async () => {
    const res = await post(
      "/api/vapi/tools/estimate",
      envelope("calculate_estimate", { service: "front_brake_pads", vehicle })
    );

    expect(res.status).toBe(200);
    expect(parsedResult(res).low).toBe(300);
  });

  it("still records an end-of-call report", async () => {
    const res = await post("/api/vapi/events", {
      message: {
        type: "end-of-call-report",
        call: { id: "vapi-call-1" },
        endedReason: "customer-ended-call"
      }
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(persistCall).toHaveBeenCalledTimes(1);
  });
});

describe("appointment requests without Twilio", () => {
  it("still persists the request", async () => {
    const res = await post("/api/vapi/tools/appointment-request", envelope("create_appointment_request", appointmentArgs));

    expect(res.status).toBe(200);
    expect(mockAppointment).toHaveBeenCalledTimes(1);
    expect(parsedResult(res).requestId).toBe("appointment-1");
    expect(parsedResult(res).status).toBe("pending");
  });

  it("reports the shop notification as not_configured", async () => {
    const res = await post("/api/vapi/tools/appointment-request", envelope("create_appointment_request", appointmentArgs));

    expect(parsedResult(res).shopNotification).toBe("not_configured");
  });

  it("reports not_configured when a confirmation was asked for and a phone exists", async () => {
    const res = await post(
      "/api/vapi/tools/appointment-request",
      envelope("create_appointment_request", { ...appointmentArgs, customerSmsConsent: true })
    );

    expect(parsedResult(res).customerConfirmation).toBe("not_configured");
  });

  it("still reports not_requested when the caller did not consent", async () => {
    const res = await post("/api/vapi/tools/appointment-request", envelope("create_appointment_request", appointmentArgs));

    expect(parsedResult(res).customerConfirmation).toBe("not_requested");
  });

  it("still reports no_phone when consent was given without a number", async () => {
    const res = await post(
      "/api/vapi/tools/appointment-request",
      envelope("create_appointment_request", {
        service: "front_brake_pads",
        preferredDate: "2026-08-25",
        customerSmsConsent: true
      })
    );

    expect(parsedResult(res).customerConfirmation).toBe("no_phone");
  });

  it("contacts Twilio not at all", async () => {
    await post(
      "/api/vapi/tools/appointment-request",
      envelope("create_appointment_request", { ...appointmentArgs, customerSmsConsent: true })
    );

    expect(mockSendSms).not.toHaveBeenCalled();
    // Not even a notification row is claimed, since nothing will be sent.
    expect(mockClaim).not.toHaveBeenCalled();
  });
});

describe("callback requests without Twilio", () => {
  it("still persists the request", async () => {
    const res = await post("/api/vapi/tools/callback-request", envelope("create_callback_request", callbackArgs));

    expect(res.status).toBe(200);
    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(parsedResult(res).requestId).toBe("callback-1");
    expect(parsedResult(res).status).toBe("pending");
  });

  it("reports both notifications honestly", async () => {
    const res = await post(
      "/api/vapi/tools/callback-request",
      envelope("create_callback_request", { ...callbackArgs, customerSmsConsent: true })
    );

    expect(parsedResult(res).shopNotification).toBe("not_configured");
    expect(parsedResult(res).customerConfirmation).toBe("not_configured");
  });

  it("preserves not_requested without consent", async () => {
    const res = await post("/api/vapi/tools/callback-request", envelope("create_callback_request", callbackArgs));

    expect(parsedResult(res).customerConfirmation).toBe("not_requested");
  });

  it("contacts Twilio not at all", async () => {
    await post(
      "/api/vapi/tools/callback-request",
      envelope("create_callback_request", { ...callbackArgs, customerSmsConsent: true })
    );

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("never says a text was sent", async () => {
    const res = await post(
      "/api/vapi/tools/callback-request",
      envelope("create_callback_request", { ...callbackArgs, customerSmsConsent: true })
    );

    const parsed = parsedResult(res);
    expect(parsed.shopNotification).not.toBe("sent");
    expect(parsed.customerConfirmation).not.toBe("sent");
  });
});
