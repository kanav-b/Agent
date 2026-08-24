import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * The whole app with the SMS master switch off — the default.
 *
 * Everything else must work exactly as normal, nothing may reach Twilio, and
 * the tool results must say "disabled" rather than pretending something
 * failed or was never asked for.
 */

// SMS_ENABLED is deliberately not set: this proves the default is off.
// Twilio credentials ARE present, to prove that having them is not enough.
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = "test-vapi-secret-not-real";
process.env.SMS_ENABLED = "";
process.env.TWILIO_ACCOUNT_SID = "AC_test_sid_not_real";
process.env.TWILIO_AUTH_TOKEN = "test_twilio_token_not_real";
process.env.TWILIO_FROM_NUMBER = "+15550000001";
process.env.SHOP_NOTIFICATION_NUMBER = "+15550000002";

vi.mock("./twilioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./twilioClient.js")>();
  return { ...actual, sendSms: vi.fn() };
});

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

vi.mock("../business/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../business/config.js")>();
  return {
    ...actual,
    resolveBusiness: vi.fn(async (id: string) => ({
      ok: true as const,
      business: {
        id,
        name: "Demo Auto Repair",
        phone: null,
        timezone: "America/Los_Angeles",
        afterHoursMessage: null,
        isActive: true,
        hours: []
      }
    })),
    resolveServicePricing: vi.fn(async (_businessId: string, serviceKey: string) => {
      const catalog: Record<string, { low: number; high: number }> = {
        synthetic_oil_change: { low: 80, high: 120 },
        front_brake_pads: { low: 300, high: 450 },
        battery_replacement: { low: 190, high: 340 },
        diagnostic: { low: 149, high: 149 },
        tire_rotation: { low: 40, high: 60 }
      };
      const found = catalog[serviceKey];
      if (!found) {
        return { ok: false as const, problem: "unknown_service" as const };
      }
      return {
        ok: true as const,
        pricing: {
          serviceKey,
          low: found.low,
          high: found.high,
          currency: "USD",
          disclaimer: "Final pricing is subject to vehicle inspection."
        }
      };
    }),
    listAvailableServiceKeys: vi.fn(async () => [
      "battery_replacement",
      "diagnostic",
      "front_brake_pads",
      "synthetic_oil_change",
      "tire_rotation"
    ])
  };
});

import { createApp } from "../app.js";
import { isSmsEnabled } from "../config.js";
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

const TEST_SECRET = "test-vapi-secret-not-real";
const vehicle = { year: 2019, make: "Toyota", model: "Camry" };

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

const callbackArgs = { customer: { name: "Dana", phone: "+14085551234" }, reason: "brake question" };

const parsedResult = (res: { body: { results: { result: string }[] } }) =>
  JSON.parse(res.body.results[0].result);

const APPOINTMENT = "/api/vapi/tools/appointment-request";
const CALLBACK = "/api/vapi/tools/callback-request";

beforeEach(() => {
  vi.clearAllMocks();
  mockAppointment.mockResolvedValue({ requestId: "appointment-1", reused: false });
  mockCallback.mockResolvedValue({ requestId: "callback-1", reused: false });
  vi.mocked(persistEstimate).mockImplementation(async (input) => ({
    estimateId: input.estimateId,
    reused: false
  }));
  vi.mocked(persistCall).mockResolvedValue({ duplicate: false, customerId: null });
  vi.mocked(findEstimatesForCall).mockResolvedValue([]);
  vi.mocked(hasRequestForCall).mockResolvedValue(false);
});

describe("the SMS switch defaults to off", () => {
  it("is off when SMS_ENABLED is not set", () => {
    expect(isSmsEnabled()).toBe(false);
  });

  it("stays off even though Twilio is fully configured", async () => {
    await post(APPOINTMENT, envelope("create_appointment_request", appointmentArgs));

    expect(mockSendSms).not.toHaveBeenCalled();
  });
});

describe("nothing is attempted while SMS is off", () => {
  it("never calls Twilio for an appointment request", async () => {
    await post(
      APPOINTMENT,
      envelope("create_appointment_request", { ...appointmentArgs, customerSmsConsent: true })
    );

    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it("never claims a notification row", async () => {
    await post(
      APPOINTMENT,
      envelope("create_appointment_request", { ...appointmentArgs, customerSmsConsent: true })
    );

    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("never calls Twilio for a callback request", async () => {
    await post(
      CALLBACK,
      envelope("create_callback_request", { ...callbackArgs, customerSmsConsent: true })
    );

    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });
});

describe("tool results while SMS is off", () => {
  it("reports the shop notification as disabled", async () => {
    const res = await post(APPOINTMENT, envelope("create_appointment_request", appointmentArgs));

    expect(parsedResult(res).shopNotification).toBe("disabled");
  });

  it("reports disabled when a confirmation was wanted and a phone exists", async () => {
    const res = await post(
      APPOINTMENT,
      envelope("create_appointment_request", { ...appointmentArgs, customerSmsConsent: true })
    );

    expect(parsedResult(res).customerConfirmation).toBe("disabled");
  });

  it("still reports not_requested when the caller did not consent", async () => {
    const res = await post(APPOINTMENT, envelope("create_appointment_request", appointmentArgs));

    expect(parsedResult(res).customerConfirmation).toBe("not_requested");
  });

  it("still reports no_phone when consent was given without a number", async () => {
    const res = await post(
      APPOINTMENT,
      envelope("create_appointment_request", {
        service: "front_brake_pads",
        preferredDate: "2026-08-25",
        customerSmsConsent: true
      })
    );

    expect(parsedResult(res).customerConfirmation).toBe("no_phone");
  });

  it("never reports failed for something deliberately switched off", async () => {
    const res = await post(
      CALLBACK,
      envelope("create_callback_request", { ...callbackArgs, customerSmsConsent: true })
    );

    const parsed = parsedResult(res);
    expect(parsed.shopNotification).toBe("disabled");
    expect(parsed.customerConfirmation).toBe("disabled");
    expect(parsed.shopNotification).not.toBe("failed");
    expect(parsed.customerConfirmation).not.toBe("sent");
  });
});

describe("the receptionist works normally while SMS is off", () => {
  it("still persists an appointment request", async () => {
    const res = await post(APPOINTMENT, envelope("create_appointment_request", appointmentArgs));

    expect(res.status).toBe(200);
    expect(mockAppointment).toHaveBeenCalledTimes(1);
    expect(parsedResult(res).requestId).toBe("appointment-1");
    expect(parsedResult(res).status).toBe("pending");
  });

  it("still persists a callback request", async () => {
    const res = await post(CALLBACK, envelope("create_callback_request", callbackArgs));

    expect(res.status).toBe(200);
    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(parsedResult(res).requestId).toBe("callback-1");
  });

  it("still records consent on the request even though no text goes out", async () => {
    await post(
      APPOINTMENT,
      envelope("create_appointment_request", { ...appointmentArgs, customerSmsConsent: true })
    );

    expect(mockAppointment.mock.calls[0][0].customerSmsConsent).toBe(true);
  });

  it("still answers the estimate endpoint", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    expect(res.status).toBe(200);
    expect(res.body.low).toBe(300);
  });

  it("still answers the estimate tool", async () => {
    const res = await post(
      "/api/vapi/tools/estimate",
      envelope("calculate_estimate", { service: "front_brake_pads", vehicle })
    );

    expect(parsedResult(res).high).toBe(450);
  });

  it("still records an end-of-call report", async () => {
    const res = await post("/api/vapi/events", {
      message: { type: "end-of-call-report", call: { id: "vapi-call-1" } }
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("still answers /health", async () => {
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
