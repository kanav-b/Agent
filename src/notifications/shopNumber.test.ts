import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Shop alerts when there is no global fallback number.
 *
 * SHOP_NOTIFICATION_NUMBER is deliberately blank here, so the only possible
 * destination is a shop's own notification_phone.
 */

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

process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = "test-vapi-secret-not-real";
process.env.SMS_ENABLED = "true";
process.env.TWILIO_ACCOUNT_SID = "AC_test_sid_not_real";
process.env.TWILIO_AUTH_TOKEN = "test_twilio_token_not_real";
process.env.TWILIO_FROM_NUMBER = "+15550000001";
// Blank, not deleted, so a real .env cannot put a value back.
process.env.SHOP_NOTIFICATION_NUMBER = "";

import { sendSms } from "./twilioClient.js";
import { getBusiness } from "../db/businesses.js";
import { claimNotification, findBusinessName, markNotificationSent } from "../db/notifications.js";
import { sendShopAppointmentNotification, sendCustomerAppointmentConfirmation } from "./sms.js";

const mockSendSms = vi.mocked(sendSms);
const mockGetBusiness = vi.mocked(getBusiness);
const mockClaim = vi.mocked(claimNotification);

const ref = { businessId: "demo-shop", vapiCallId: "vapi-call-1", requestId: "request-1" };
const appointment = {
  service: "front_brake_pads",
  preferredDate: "2026-08-25",
  customerName: "Dana",
  customerPhone: "+14085551234"
};

const business = (notificationPhone: string | null) => ({
  id: "demo-shop",
  name: "Demo Auto Repair",
  phone: null,
  notificationPhone,
  timezone: "America/Los_Angeles",
  afterHoursMessage: null,
  isActive: true
});

beforeEach(() => {
  vi.clearAllMocks();
  mockClaim.mockResolvedValue({ notificationId: "notification-1" });
  mockSendSms.mockResolvedValue({ providerMessageId: "SM_test" });
  vi.mocked(markNotificationSent).mockResolvedValue(undefined);
  vi.mocked(findBusinessName).mockResolvedValue("Demo Auto Repair");
});

describe("with no global fallback number", () => {
  it("still sends when the shop has its own number", async () => {
    mockGetBusiness.mockResolvedValue(business("+15559990000"));

    const status = await sendShopAppointmentNotification(ref, appointment);

    expect(status).toBe("sent");
    expect(mockSendSms.mock.calls[0][0]).toBe("+15559990000");
  });

  it("reports not_configured when the shop has none either", async () => {
    mockGetBusiness.mockResolvedValue(business(null));

    const status = await sendShopAppointmentNotification(ref, appointment);

    expect(status).toBe("not_configured");
  });

  it("attempts nothing at all when there is nowhere to send", async () => {
    mockGetBusiness.mockResolvedValue(business(null));

    await sendShopAppointmentNotification(ref, appointment);

    expect(mockSendSms).not.toHaveBeenCalled();
    // No notification row is claimed for a message that was never possible.
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("does not report a failure for something that was never attempted", async () => {
    mockGetBusiness.mockResolvedValue(business(null));

    const status = await sendShopAppointmentNotification(ref, appointment);

    expect(status).not.toBe("failed");
  });

  it("still texts the caller, whose number is their own", async () => {
    mockGetBusiness.mockResolvedValue(business(null));

    const status = await sendCustomerAppointmentConfirmation(ref, appointment, true);

    // A missing shop number says nothing about reaching the caller.
    expect(status).toBe("sent");
    expect(mockSendSms.mock.calls[0][0]).toBe("+14085551234");
  });
});
