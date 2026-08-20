import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase.js", () => ({ getSupabase: vi.fn() }));

import { getSupabase } from "./supabase.js";
import {
  claimNotification,
  findNotificationStatus,
  markNotificationFailed,
  markNotificationSent,
  NotificationError
} from "./notifications.js";

interface Recorded {
  table: string;
  op: "select" | "insert" | "update";
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
}

type Reply = { data?: unknown; error?: unknown };

let calls: Recorded[] = [];
let replies: Record<string, Reply>;

function fakeClient() {
  return {
    from(table: string) {
      const call: Recorded = { table, op: "select", filters: {} };
      const finish = () => {
        calls.push(call);
        return Promise.resolve(replies[`${table}.${call.op}`] ?? {});
      };
      const builder = {
        select: () => builder,
        insert(payload: Record<string, unknown>) {
          call.op = "insert";
          call.payload = payload;
          return builder;
        },
        update(payload: Record<string, unknown>) {
          call.op = "update";
          call.payload = payload;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters[column] = value;
          return builder;
        },
        maybeSingle: finish,
        single: finish,
        then: (ok: (v: Reply) => unknown, err?: (e: unknown) => unknown) => finish().then(ok, err)
      };
      return builder;
    }
  };
}

const target = {
  businessId: "demo-shop",
  vapiCallId: "vapi-call-1",
  appointmentRequestId: "request-1",
  notificationType: "appointment_request_shop" as const,
  recipientType: "shop" as const
};

const inserted = () => calls.find((c) => c.table === "notifications" && c.op === "insert")?.payload;

beforeEach(() => {
  calls = [];
  replies = { "notifications.insert": { data: { id: "notification-1" } } };
  vi.mocked(getSupabase).mockImplementation(() => fakeClient() as never);
});

describe("claimNotification", () => {
  it("writes a pending row and returns its id", async () => {
    const claim = await claimNotification(target);

    expect(claim).toEqual({ notificationId: "notification-1" });
    // status is left to the column default of 'pending'.
    expect(inserted()).not.toHaveProperty("status");
  });

  it("records the ids, kinds, and channel", async () => {
    await claimNotification(target);

    expect(inserted()).toEqual({
      business_id: "demo-shop",
      vapi_call_id: "vapi-call-1",
      appointment_request_id: "request-1",
      callback_request_id: null,
      recipient_type: "shop",
      channel: "sms",
      notification_type: "appointment_request_shop"
    });
  });

  it("stores no message body and no phone number", async () => {
    await claimNotification(target);

    const columns = Object.keys(inserted() ?? {});
    expect(columns).not.toContain("body");
    expect(columns).not.toContain("message");
    expect(columns).not.toContain("to");
    expect(columns).not.toContain("phone");
    expect(columns).not.toContain("recipient_number");
    // Nothing in the payload looks like a phone number or message text.
    expect(JSON.stringify(inserted())).not.toMatch(/\+\d{7,}/);
  });

  it("returns null when the same notification was already claimed", async () => {
    replies["notifications.insert"] = { error: { code: "23505", message: "duplicate key" } };

    expect(await claimNotification(target)).toBeNull();
  });

  it("raises anything that is not a duplicate", async () => {
    replies["notifications.insert"] = { error: { code: "23503", message: "fk violation" } };

    const err = await claimNotification(target).catch((e) => e);

    expect(err).toBeInstanceOf(NotificationError);
    expect(err.code).toBe("23503");
  });
});

describe("recording the outcome", () => {
  it("marks a notification sent with the provider message id", async () => {
    replies["notifications.update"] = {};

    await markNotificationSent("notification-1", "twilio", "SM_test");

    const update = calls.find((c) => c.op === "update");
    expect(update?.payload).toMatchObject({
      status: "sent",
      provider: "twilio",
      provider_message_id: "SM_test"
    });
    expect(update?.filters).toEqual({ id: "notification-1" });
  });

  it("marks a notification failed with only the provider code", async () => {
    replies["notifications.update"] = {};

    await markNotificationFailed("notification-1", "twilio", "21211");

    const update = calls.find((c) => c.op === "update");
    expect(update?.payload).toEqual({ status: "failed", provider: "twilio", error_code: "21211" });
    // No exception text, no stack, no body.
    expect(JSON.stringify(update?.payload)).not.toMatch(/Error|stack|at \//);
  });

  it("reads back the status of an existing notification", async () => {
    replies["notifications.select"] = { data: { status: "sent" } };

    expect(
      await findNotificationStatus({
        notificationType: "appointment_request_shop",
        appointmentRequestId: "request-1"
      })
    ).toBe("sent");
  });

  it("returns null when there is no such notification", async () => {
    replies["notifications.select"] = { data: null };

    expect(
      await findNotificationStatus({
        notificationType: "callback_request_customer",
        callbackRequestId: "request-9"
      })
    ).toBeNull();
  });
});
