import { beforeEach, describe, expect, it, vi } from "vitest";

// Twilio and the database are both stubbed: nothing here touches a network.
vi.mock("./twilioClient.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./twilioClient.js")>();
  return { ...actual, sendSms: vi.fn() };
});
vi.mock("../db/businesses.js", () => ({ getBusiness: vi.fn() }));
vi.mock("../db/notifications.js", () => ({
  claimNotification: vi.fn(),
  findNotificationStatus: vi.fn(),
  markNotificationSent: vi.fn(),
  markNotificationFailed: vi.fn(),
  findBusinessName: vi.fn()
}));

// Fake Twilio settings. No real credentials appear in any test.
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = "test-vapi-secret-not-real";
process.env.SMS_ENABLED = "true";
process.env.TWILIO_ACCOUNT_SID = "AC_test_sid_not_real";
process.env.TWILIO_AUTH_TOKEN = "test_twilio_token_not_real";
process.env.TWILIO_FROM_NUMBER = "+15550000001";
process.env.SHOP_NOTIFICATION_NUMBER = "+15550000002";

import { sendSms, SmsSendError } from "./twilioClient.js";
import { getBusiness } from "../db/businesses.js";
import {
  claimNotification,
  findBusinessName,
  findNotificationStatus,
  markNotificationFailed,
  markNotificationSent
} from "../db/notifications.js";
import {
  sendCustomerAppointmentConfirmation,
  sendCustomerCallbackConfirmation,
  sendShopAppointmentNotification,
  sendShopCallbackNotification
} from "./sms.js";

const mockSend = vi.mocked(sendSms);
const mockClaim = vi.mocked(claimNotification);
const mockStatus = vi.mocked(findNotificationStatus);
const mockSent = vi.mocked(markNotificationSent);
const mockFailed = vi.mocked(markNotificationFailed);
const mockBusinessName = vi.mocked(findBusinessName);
const mockGetBusiness = vi.mocked(getBusiness);

const SHOP_NUMBER = "+15550000002";
const CALLER_NUMBER = "+14085551234";

const ref = { businessId: "demo-shop", vapiCallId: "vapi-call-1", requestId: "request-1" };

const appointment = {
  vehicleYear: 2019,
  vehicleMake: "Toyota",
  vehicleModel: "Camry",
  service: "front_brake_pads",
  preferredDate: "2026-08-25",
  preferredTimeText: "morning",
  customerName: "Dana",
  customerPhone: CALLER_NUMBER
};

const callback = {
  reason: "brake service question",
  preferredCallbackAt: "2026-08-20T14:00:00Z",
  customerName: "Dana",
  customerPhone: CALLER_NUMBER
};

const sentBody = () => mockSend.mock.calls[0][1];
const sentTo = () => mockSend.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  mockClaim.mockResolvedValue({ notificationId: "notification-1" });
  mockSend.mockResolvedValue({ providerMessageId: "SM_test_sid" });
  mockSent.mockResolvedValue(undefined);
  mockFailed.mockResolvedValue(undefined);
  mockStatus.mockResolvedValue(null);
  mockBusinessName.mockResolvedValue("Demo Auto Repair");
  // No shop-specific number by default, so the global fallback is used.
  mockGetBusiness.mockResolvedValue({
    id: "demo-shop",
    name: "Demo Auto Repair",
    phone: null,
    notificationPhone: null,
    timezone: "America/Los_Angeles",
    afterHoursMessage: null,
    isActive: true
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("shop notifications", () => {
  it("sends exactly one SMS for an appointment request", async () => {
    const status = await sendShopAppointmentNotification(ref, appointment);

    expect(status).toBe("sent");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("sends exactly one SMS for a callback request", async () => {
    const status = await sendShopCallbackNotification(ref, callback);

    expect(status).toBe("sent");
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it("sends to SHOP_NOTIFICATION_NUMBER", async () => {
    await sendShopAppointmentNotification(ref, appointment);

    expect(sentTo()).toBe(SHOP_NUMBER);
  });

  it("includes the vehicle, service, and preference for the shop", async () => {
    await sendShopAppointmentNotification(ref, appointment);

    expect(sentBody()).toContain("2019 Toyota Camry");
    expect(sentBody()).toContain("front_brake_pads");
    expect(sentBody()).toContain("2026-08-25");
  });

  it("never tells the shop the appointment is booked", async () => {
    await sendShopAppointmentNotification(ref, appointment);

    expect(sentBody()).not.toMatch(/booked|confirmed|reserved|guaranteed/i);
    expect(sentBody()).toContain("Pending");
  });

  it("includes the caller's details for the shop, which is the recipient", async () => {
    await sendShopAppointmentNotification(ref, appointment);

    expect(sentBody()).toContain("Dana");
    expect(sentBody()).toContain(CALLER_NUMBER);
  });

  it("omits caller details cleanly when there are none", async () => {
    await sendShopCallbackNotification(ref, { reason: "brake question" });

    expect(sentBody()).not.toContain("Caller:");
    expect(sentBody()).not.toMatch(/undefined|null/);
  });

  it("records the notification as sent with the provider message id", async () => {
    await sendShopAppointmentNotification(ref, appointment);

    expect(mockSent).toHaveBeenCalledWith("notification-1", "twilio", "SM_test_sid");
  });

  it("claims the notification before sending, so a retry cannot double up", async () => {
    await sendShopAppointmentNotification(ref, appointment);

    expect(mockClaim).toHaveBeenCalledTimes(1);
    expect(mockClaim.mock.calls[0][0]).toMatchObject({
      businessId: "demo-shop",
      notificationType: "appointment_request_shop",
      recipientType: "shop",
      appointmentRequestId: "request-1"
    });
  });

  it("sends nothing when the notification was already claimed", async () => {
    mockClaim.mockResolvedValue(null);
    mockStatus.mockResolvedValue("sent");

    const status = await sendShopAppointmentNotification(ref, appointment);

    expect(status).toBe("sent");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("reports the original failure when a retry finds a failed attempt", async () => {
    mockClaim.mockResolvedValue(null);
    mockStatus.mockResolvedValue("failed");

    const status = await sendShopCallbackNotification(ref, callback);

    expect(status).toBe("failed");
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("provider failure", () => {
  it("reports failed and records the provider error code", async () => {
    mockSend.mockRejectedValue(new SmsSendError("21211"));

    const status = await sendShopAppointmentNotification(ref, appointment);

    expect(status).toBe("failed");
    expect(mockFailed).toHaveBeenCalledWith("notification-1", "twilio", "21211");
  });

  it("does not throw, so the request that triggered it survives", async () => {
    mockSend.mockRejectedValue(new SmsSendError("30007"));

    await expect(sendShopCallbackNotification(ref, callback)).resolves.toBe("failed");
  });

  it("still reports failed when even the bookkeeping fails", async () => {
    mockSend.mockRejectedValue(new SmsSendError("21211"));
    mockFailed.mockRejectedValue(new Error("database down"));

    await expect(sendShopAppointmentNotification(ref, appointment)).resolves.toBe("failed");
  });

  it("logs only ids and the provider code, never personal data", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => logged.push(String(msg)));
    mockSend.mockRejectedValue(new SmsSendError("21211"));

    await sendShopAppointmentNotification(ref, appointment);

    const output = logged.join("\n");
    expect(output).toContain("type=appointment_request_shop");
    expect(output).toContain('providerErrorCode="21211"');
    expect(output).toContain('requestId="request-1"');
    expect(output).not.toContain(CALLER_NUMBER);
    expect(output).not.toContain(SHOP_NUMBER);
    expect(output).not.toContain("Dana");
    expect(output).not.toContain("front_brake_pads");
    expect(output).not.toContain("test_twilio_token_not_real");
    expect(output).not.toContain("test-vapi-secret-not-real");
  });
});

describe("customer confirmations — consent", () => {
  it("sends an appointment confirmation with consent and a phone number", async () => {
    const status = await sendCustomerAppointmentConfirmation(ref, appointment, true);

    expect(status).toBe("sent");
    expect(sentTo()).toBe(CALLER_NUMBER);
  });

  it("sends nothing when consent is false", async () => {
    const status = await sendCustomerAppointmentConfirmation(ref, appointment, false);

    expect(status).toBe("not_requested");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("sends nothing when consent is given but there is no phone number", async () => {
    const status = await sendCustomerAppointmentConfirmation(
      ref,
      { ...appointment, customerPhone: undefined },
      true
    );

    expect(status).toBe("no_phone");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends a callback confirmation with consent", async () => {
    const status = await sendCustomerCallbackConfirmation(ref, callback, true);

    expect(status).toBe("sent");
    expect(sentTo()).toBe(CALLER_NUMBER);
  });

  it("sends no callback confirmation without consent", async () => {
    const status = await sendCustomerCallbackConfirmation(ref, callback, false);

    expect(status).toBe("not_requested");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("does not text a caller twice on a retry", async () => {
    mockClaim.mockResolvedValue(null);
    mockStatus.mockResolvedValue("sent");

    const status = await sendCustomerAppointmentConfirmation(ref, appointment, true);

    expect(status).toBe("sent");
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("records a customer notification of the right type", async () => {
    await sendCustomerCallbackConfirmation(ref, callback, true);

    expect(mockClaim.mock.calls[0][0]).toMatchObject({
      notificationType: "callback_request_customer",
      recipientType: "customer",
      callbackRequestId: "request-1"
    });
  });
});

describe("customer confirmation wording", () => {
  it("says plainly that the appointment is not confirmed", async () => {
    await sendCustomerAppointmentConfirmation(ref, appointment, true);

    expect(sentBody()).toContain("Demo Auto Repair");
    expect(sentBody()).toContain("This is not a confirmed appointment.");
    expect(sentBody()).toMatch(/follow up to confirm/i);
  });

  it("never claims the appointment is booked or reserved", async () => {
    await sendCustomerAppointmentConfirmation(ref, appointment, true);

    expect(sentBody()).not.toMatch(/\bbooked\b|\breserved\b|\bguaranteed\b/i);
  });

  it("mentions a preferred time only as a preference", async () => {
    await sendCustomerCallbackConfirmation(ref, callback, true);

    expect(sentBody()).toContain("pending until someone from the shop follows up");
    expect(sentBody()).toMatch(/preference, not a guaranteed time/i);
  });

  it("promises no callback time when none was asked for", async () => {
    await sendCustomerCallbackConfirmation(ref, { ...callback, preferredCallbackAt: undefined }, true);

    expect(sentBody()).not.toMatch(/we will call|someone will call you at|guaranteed/i);
  });

  it("carries no transcript or internal detail", async () => {
    await sendCustomerAppointmentConfirmation(ref, appointment, true);

    expect(sentBody()).not.toMatch(/User:|Assistant:|toolCallId|SUPABASE|TWILIO/i);
  });

  it("falls back to the business id when the shop has no name", async () => {
    mockBusinessName.mockResolvedValue(null);

    await sendCustomerAppointmentConfirmation(ref, appointment, true);

    expect(sentBody()).toContain("demo-shop");
  });
});

describe("where a shop alert is sent", () => {
  const withNotificationPhone = (phone: string | null) => {
    mockGetBusiness.mockResolvedValue({
      id: "demo-shop",
      name: "Demo Auto Repair",
      phone: null,
      notificationPhone: phone,
      timezone: "America/Los_Angeles",
      afterHoursMessage: null,
      isActive: true
    });
  };

  it("prefers the shop's own notification_phone", async () => {
    withNotificationPhone("+15559990000");

    await sendShopAppointmentNotification(ref, appointment);

    expect(sentTo()).toBe("+15559990000");
    expect(sentTo()).not.toBe(SHOP_NUMBER);
  });

  it("uses the shop's own number for callbacks too", async () => {
    withNotificationPhone("+15559990000");

    await sendShopCallbackNotification(ref, callback);

    expect(sentTo()).toBe("+15559990000");
  });

  it("falls back to SHOP_NOTIFICATION_NUMBER when the shop has none", async () => {
    withNotificationPhone(null);

    await sendShopAppointmentNotification(ref, appointment);

    expect(sentTo()).toBe(SHOP_NUMBER);
  });

  it("falls back when the business cannot be read at all", async () => {
    mockGetBusiness.mockRejectedValue(new Error("database down"));

    const status = await sendShopAppointmentNotification(ref, appointment);

    expect(status).toBe("sent");
    expect(sentTo()).toBe(SHOP_NUMBER);
  });

  it("does not change where a caller confirmation goes", async () => {
    withNotificationPhone("+15559990000");

    await sendCustomerAppointmentConfirmation(ref, appointment, true);

    // Caller texts go to the caller, never to a shop number.
    expect(sentTo()).toBe(CALLER_NUMBER);
  });
});

