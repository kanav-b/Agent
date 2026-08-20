import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// The database is stubbed: these tests never reach the network.
vi.mock("../db/requests.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/requests.js")>();
  return {
    ...actual,
    createAppointmentRequest: vi.fn(),
    createCallbackRequest: vi.fn()
  };
});

vi.mock("../notifications/sms.js", () => ({
  sendShopAppointmentNotification: vi.fn(),
  sendShopCallbackNotification: vi.fn(),
  sendCustomerAppointmentConfirmation: vi.fn(),
  sendCustomerCallbackConfirmation: vi.fn()
}));

import { createApp } from "../app.js";
import {
  sendCustomerAppointmentConfirmation,
  sendCustomerCallbackConfirmation,
  sendShopAppointmentNotification,
  sendShopCallbackNotification
} from "../notifications/sms.js";
import { createAppointmentRequest, createCallbackRequest } from "../db/requests.js";
import { VAPI_SECRET_HEADER } from "../middleware/vapiAuth.js";

const mockAppointment = vi.mocked(createAppointmentRequest);
const mockCallback = vi.mocked(createCallbackRequest);
const mockShopAppointmentSms = vi.mocked(sendShopAppointmentNotification);
const mockShopCallbackSms = vi.mocked(sendShopCallbackNotification);
const mockCustomerAppointmentSms = vi.mocked(sendCustomerAppointmentConfirmation);
const mockCustomerCallbackSms = vi.mocked(sendCustomerCallbackConfirmation);

const TEST_SECRET = "test-vapi-secret-not-real";
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = TEST_SECRET;

const app = createApp();

const APPOINTMENT_ROUTE = "/api/vapi/tools/appointment-request";
const CALLBACK_ROUTE = "/api/vapi/tools/callback-request";

const post = (route: string, body: object) =>
  request(app).post(route).set(VAPI_SECRET_HEADER, TEST_SECRET).send(body);

/** Builds a Vapi tool-call envelope. */
function envelope(
  name: string,
  args: Record<string, unknown>,
  { id = "tc-1", vapiCallId }: { id?: string; vapiCallId?: string } = {}
) {
  const message: Record<string, unknown> = {
    type: "tool-calls",
    toolCallList: [{ id, function: { name, arguments: args } }]
  };
  if (vapiCallId) {
    message.call = { id: vapiCallId };
  }
  return { message };
}

const appointmentArgs = {
  customer: { name: "Dana", phone: "+14085551234" },
  vehicle: { year: 2019, make: "Toyota", model: "Camry" },
  service: "front_brake_pads",
  preferredDate: "2026-08-25",
  preferredTimeText: "morning"
};

const callbackArgs = {
  customer: { name: "Dana", phone: "+14085551234" },
  reason: "Wants to discuss the quote",
  preferredCallbackAt: "2026-08-20T14:00:00Z"
};

const parsedResult = (res: { body: { results: { result: string }[] } }) =>
  JSON.parse(res.body.results[0].result);

beforeEach(() => {
  mockAppointment.mockReset();
  mockAppointment.mockResolvedValue({ requestId: "appointment-1", reused: false });
  mockCallback.mockReset();
  mockCallback.mockResolvedValue({ requestId: "callback-1", reused: false });

  for (const sms of [mockShopAppointmentSms, mockShopCallbackSms]) {
    sms.mockReset();
    sms.mockResolvedValue("sent");
  }
  for (const sms of [mockCustomerAppointmentSms, mockCustomerCallbackSms]) {
    sms.mockReset();
    sms.mockResolvedValue("not_requested");
  }
});

describe("POST /api/vapi/tools/appointment-request", () => {
  it("records a valid request", async () => {
    const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(mockAppointment).toHaveBeenCalledTimes(1);
  });

  it("echoes the toolCallId", async () => {
    const res = await post(
      APPOINTMENT_ROUTE,
      envelope("create_appointment_request", appointmentArgs, { id: "tc-abc" })
    );

    expect(res.body.results[0].toolCallId).toBe("tc-abc");
  });

  it("returns the requestId and a pending status", async () => {
    const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));
    const parsed = parsedResult(res);

    expect(parsed.requestId).toBe("appointment-1");
    expect(parsed.status).toBe("pending");
  });

  it("says plainly that the appointment is not confirmed", async () => {
    const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));
    const parsed = parsedResult(res);

    expect(parsed.message).toMatch(/still needs to confirm|not booked/i);
  });

  it("never claims the appointment is booked or confirmed", async () => {
    const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

    const text = res.body.results[0].result;
    expect(text).not.toMatch(/appointment (is )?booked|appointment (is|has been) confirmed|you'?re booked/i);
  });

  it("returns the preferred date and time back", async () => {
    const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));
    const parsed = parsedResult(res);

    expect(parsed.preferredDate).toBe("2026-08-25");
    expect(parsed.preferredTimeText).toBe("morning");
  });

  it("passes the live call id through when present", async () => {
    await post(
      APPOINTMENT_ROUTE,
      envelope("create_appointment_request", appointmentArgs, { vapiCallId: "vapi-call-9" })
    );

    expect(mockAppointment.mock.calls[0][1]).toMatchObject({ vapiCallId: "vapi-call-9" });
  });

  it("invents no call id when the payload has none", async () => {
    await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

    expect(mockAppointment.mock.calls[0][1]?.vapiCallId).toBeUndefined();
  });

  it("passes the toolCallId so a retry can be recognised", async () => {
    await post(
      APPOINTMENT_ROUTE,
      envelope("create_appointment_request", appointmentArgs, { id: "tc-retry" })
    );

    expect(mockAppointment.mock.calls[0][1]).toMatchObject({ vapiToolCallId: "tc-retry" });
  });

  it("returns the original request when the tool call is retried", async () => {
    mockAppointment.mockResolvedValue({ requestId: "original-request", reused: true });

    const first = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs, { id: "tc-retry" }));
    const second = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs, { id: "tc-retry" }));

    expect(parsedResult(first).requestId).toBe("original-request");
    expect(parsedResult(second).requestId).toBe(parsedResult(first).requestId);
  });

  it("defaults the business to demo-shop", async () => {
    await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

    expect(mockAppointment.mock.calls[0][0].businessId).toBe("demo-shop");
  });

  describe("tool-level errors", () => {
    it("rejects a request with neither service nor problem description", async () => {
      const res = await post(
        APPOINTMENT_ROUTE,
        envelope("create_appointment_request", { preferredDate: "2026-08-25" })
      );

      expect(res.status).toBe(200);
      expect(res.body.results[0].error).toMatch(/service or a description/i);
      expect(mockAppointment).not.toHaveBeenCalled();
    });

    it("rejects a request with no preferred date or time", async () => {
      const res = await post(
        APPOINTMENT_ROUTE,
        envelope("create_appointment_request", { service: "front_brake_pads" })
      );

      expect(res.status).toBe(200);
      expect(res.body.results[0].error).toMatch(/preferred date|preferred time/i);
      expect(mockAppointment).not.toHaveBeenCalled();
    });

    it("rejects a malformed preferred date", async () => {
      const res = await post(
        APPOINTMENT_ROUTE,
        envelope("create_appointment_request", { service: "x", preferredDate: "next Tuesday" })
      );

      expect(res.status).toBe(200);
      expect(res.body.results[0].error).toBeTypeOf("string");
      expect(mockAppointment).not.toHaveBeenCalled();
    });

    it("accepts natural language in preferredTimeText", async () => {
      const res = await post(
        APPOINTMENT_ROUTE,
        envelope("create_appointment_request", {
          problemDescription: "grinding noise when braking",
          preferredTimeText: "after work, around 5ish"
        })
      );

      expect(res.status).toBe(200);
      expect(res.body.results[0].error).toBeUndefined();
    });

    it("returns a tool-level error when persistence fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockAppointment.mockRejectedValue(new Error("connection refused"));

      const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

      expect(res.status).toBe(200);
      expect(res.body.results[0].toolCallId).toBe("tc-1");
      expect(res.body.results[0].error).toMatch(/Could not record the appointment request/);
      expect(res.body.results[0].result).toBeUndefined();
    });

    it("never claims a request was recorded when it was not", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mockAppointment.mockRejectedValue(new Error("connection refused"));

      const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

      expect(JSON.stringify(res.body)).not.toMatch(/recorded\./);
    });

    it("rejects the wrong tool name", async () => {
      const res = await post(APPOINTMENT_ROUTE, envelope("book_appointment", appointmentArgs));

      expect(res.status).toBe(200);
      expect(res.body.results[0].error).toMatch(/Unsupported tool/);
      expect(mockAppointment).not.toHaveBeenCalled();
    });

    it("returns 400 for an envelope with no toolCallId", async () => {
      const res = await post(APPOINTMENT_ROUTE, { nonsense: true });

      expect(res.status).toBe(400);
      expect(mockAppointment).not.toHaveBeenCalled();
    });
  });
});

describe("POST /api/vapi/tools/callback-request", () => {
  it("records a valid request as pending", async () => {
    const res = await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));
    const parsed = parsedResult(res);

    expect(res.status).toBe(200);
    expect(parsed.requestId).toBe("callback-1");
    expect(parsed.status).toBe("pending");
  });

  it("returns the preferred callback time", async () => {
    const res = await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));

    expect(parsedResult(res).preferredCallbackAt).toBe("2026-08-20T14:00:00Z");
  });

  it("does not claim anyone has called yet", async () => {
    const res = await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));
    const text = res.body.results[0].result;

    expect(parsedResult(res).message).toMatch(/pending/i);
    expect(text).not.toMatch(/has called|already called|someone called|we have called/i);
  });

  it("allows a request with no phone number", async () => {
    const res = await post(
      CALLBACK_ROUTE,
      envelope("create_callback_request", { reason: "Wants a call about brakes" })
    );

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toBeUndefined();
  });

  it("allows a request with no reason", async () => {
    const res = await post(CALLBACK_ROUTE, envelope("create_callback_request", {}));

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toBeUndefined();
  });

  it("rejects a preferred time with no timezone", async () => {
    const res = await post(
      CALLBACK_ROUTE,
      envelope("create_callback_request", { preferredCallbackAt: "2026-08-20T14:00:00" })
    );

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toMatch(/timezone/i);
    expect(mockCallback).not.toHaveBeenCalled();
  });

  it("returns the original request when retried", async () => {
    mockCallback.mockResolvedValue({ requestId: "original-callback", reused: true });

    const res = await post(
      CALLBACK_ROUTE,
      envelope("create_callback_request", callbackArgs, { id: "tc-retry" })
    );

    expect(parsedResult(res).requestId).toBe("original-callback");
  });

  it("returns a tool-level error when persistence fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCallback.mockRejectedValue(new Error("connection refused"));

    const res = await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toMatch(/Could not record the callback request/);
    expect(res.body.results[0].result).toBeUndefined();
  });

  it("leaks no internal detail on failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCallback.mockRejectedValue(new Error("password=hunter2 at /src/db/requests.ts:42"));

    const res = await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));

    expect(res.text).not.toMatch(/hunter2|\.ts:|node_modules/);
  });

  it("logs no personal information on failure", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => logged.push(String(msg)));
    mockCallback.mockRejectedValue(new Error("connection refused"));

    await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));

    const output = logged.join("\n");
    expect(output).toContain("kind=callback");
    expect(output).not.toContain("+14085551234");
    expect(output).not.toContain("Dana");
    expect(output).not.toContain("Wants to discuss the quote");
  });
});

describe("request tools — authentication", () => {
  it("returns 401 without the header", async () => {
    const res = await request(app)
      .post(APPOINTMENT_ROUTE)
      .send(envelope("create_appointment_request", appointmentArgs));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized." });
  });

  it("returns 401 with the wrong secret", async () => {
    const res = await request(app)
      .post(CALLBACK_ROUTE)
      .set(VAPI_SECRET_HEADER, "wrong")
      .send(envelope("create_callback_request", callbackArgs));

    expect(res.status).toBe(401);
  });

  it("writes nothing for an unauthorised appointment request", async () => {
    await request(app)
      .post(APPOINTMENT_ROUTE)
      .send(envelope("create_appointment_request", appointmentArgs));

    expect(mockAppointment).not.toHaveBeenCalled();
  });

  it("writes nothing for an unauthorised callback request", async () => {
    await request(app)
      .post(CALLBACK_ROUTE)
      .send(envelope("create_callback_request", callbackArgs));

    expect(mockCallback).not.toHaveBeenCalled();
  });
});

describe("notifications from the appointment tool", () => {
  it("notifies the shop after the request is stored", async () => {
    await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

    expect(mockShopAppointmentSms).toHaveBeenCalledTimes(1);
  });

  it("reports the shop notification status in the result", async () => {
    const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

    expect(parsedResult(res).shopNotification).toBe("sent");
  });

  it("passes the stored request id and the vehicle to the notifier", async () => {
    await post(
      APPOINTMENT_ROUTE,
      envelope("create_appointment_request", appointmentArgs, { vapiCallId: "vapi-call-9" })
    );

    const [ref, summary] = mockShopAppointmentSms.mock.calls[0];
    expect(ref).toEqual({
      businessId: "demo-shop",
      vapiCallId: "vapi-call-9",
      requestId: "appointment-1"
    });
    expect(summary).toMatchObject({ vehicleMake: "Toyota", service: "front_brake_pads" });
  });

  it("defaults customerSmsConsent to false when the tool omits it", async () => {
    await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

    expect(mockCustomerAppointmentSms.mock.calls[0][2]).toBe(false);
    expect(mockAppointment.mock.calls[0][0].customerSmsConsent).toBe(false);
  });

  it("passes consent through when the caller agreed", async () => {
    await post(
      APPOINTMENT_ROUTE,
      envelope("create_appointment_request", { ...appointmentArgs, customerSmsConsent: true })
    );

    expect(mockCustomerAppointmentSms.mock.calls[0][2]).toBe(true);
  });

  it("reports not_requested when the caller did not ask for a text", async () => {
    const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

    expect(parsedResult(res).customerConfirmation).toBe("not_requested");
  });

  it("reports sent when the caller confirmation went out", async () => {
    mockCustomerAppointmentSms.mockResolvedValue("sent");

    const res = await post(
      APPOINTMENT_ROUTE,
      envelope("create_appointment_request", { ...appointmentArgs, customerSmsConsent: true })
    );

    expect(parsedResult(res).customerConfirmation).toBe("sent");
  });

  it("still records the request when the shop SMS fails", async () => {
    mockShopAppointmentSms.mockResolvedValue("failed");

    const res = await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));
    const parsed = parsedResult(res);

    expect(res.status).toBe(200);
    expect(parsed.requestId).toBe("appointment-1");
    expect(parsed.status).toBe("pending");
    expect(parsed.shopNotification).toBe("failed");
    expect(res.body.results[0].error).toBeUndefined();
  });

  it("never claims a text was sent when delivery failed", async () => {
    mockCustomerAppointmentSms.mockResolvedValue("failed");

    const res = await post(
      APPOINTMENT_ROUTE,
      envelope("create_appointment_request", { ...appointmentArgs, customerSmsConsent: true })
    );

    expect(parsedResult(res).customerConfirmation).toBe("failed");
    expect(parsedResult(res).customerConfirmation).not.toBe("sent");
  });

  it("reports no_phone when consent was given without a number", async () => {
    mockCustomerAppointmentSms.mockResolvedValue("no_phone");

    const res = await post(
      APPOINTMENT_ROUTE,
      envelope("create_appointment_request", {
        service: "front_brake_pads",
        preferredDate: "2026-08-25",
        customerSmsConsent: true
      })
    );

    expect(parsedResult(res).customerConfirmation).toBe("no_phone");
  });

  it("sends no SMS when persistence failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockAppointment.mockRejectedValue(new Error("connection refused"));

    await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", appointmentArgs));

    expect(mockShopAppointmentSms).not.toHaveBeenCalled();
    expect(mockCustomerAppointmentSms).not.toHaveBeenCalled();
  });

  it("sends no SMS when validation failed", async () => {
    await post(APPOINTMENT_ROUTE, envelope("create_appointment_request", { service: "x" }));

    expect(mockShopAppointmentSms).not.toHaveBeenCalled();
  });
});

describe("notifications from the callback tool", () => {
  it("notifies the shop and reports the status", async () => {
    const res = await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));

    expect(mockShopCallbackSms).toHaveBeenCalledTimes(1);
    expect(parsedResult(res).shopNotification).toBe("sent");
  });

  it("sends a caller confirmation only with consent", async () => {
    mockCustomerCallbackSms.mockResolvedValue("sent");

    const res = await post(
      CALLBACK_ROUTE,
      envelope("create_callback_request", { ...callbackArgs, customerSmsConsent: true })
    );

    expect(mockCustomerCallbackSms.mock.calls[0][2]).toBe(true);
    expect(parsedResult(res).customerConfirmation).toBe("sent");
  });

  it("still records the request when the shop SMS fails", async () => {
    mockShopCallbackSms.mockResolvedValue("failed");

    const res = await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));

    expect(parsedResult(res).requestId).toBe("callback-1");
    expect(parsedResult(res).status).toBe("pending");
    expect(res.body.results[0].error).toBeUndefined();
  });

  it("reports not_configured when Twilio is not set up", async () => {
    mockShopCallbackSms.mockResolvedValue("not_configured");

    const res = await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));

    expect(parsedResult(res).shopNotification).toBe("not_configured");
    expect(parsedResult(res).requestId).toBe("callback-1");
  });

  it("sends no SMS when persistence failed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockCallback.mockRejectedValue(new Error("connection refused"));

    await post(CALLBACK_ROUTE, envelope("create_callback_request", callbackArgs));

    expect(mockShopCallbackSms).not.toHaveBeenCalled();
    expect(mockCustomerCallbackSms).not.toHaveBeenCalled();
  });
});

describe("unauthorised requests send nothing", () => {
  it("sends no SMS for an unauthenticated appointment request", async () => {
    await request(app)
      .post(APPOINTMENT_ROUTE)
      .send(envelope("create_appointment_request", appointmentArgs));

    expect(mockShopAppointmentSms).not.toHaveBeenCalled();
    expect(mockCustomerAppointmentSms).not.toHaveBeenCalled();
  });

  it("sends no SMS for an unauthenticated callback request", async () => {
    await request(app)
      .post(CALLBACK_ROUTE)
      .set(VAPI_SECRET_HEADER, "wrong")
      .send(envelope("create_callback_request", callbackArgs));

    expect(mockShopCallbackSms).not.toHaveBeenCalled();
    expect(mockCustomerCallbackSms).not.toHaveBeenCalled();
  });
});

