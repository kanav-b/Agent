import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Supabase client so the real logic runs with no network.
vi.mock("./supabase.js", () => ({ getSupabase: vi.fn() }));

import { getSupabase } from "./supabase.js";
import {
  createAppointmentRequest,
  createCallbackRequest,
  hasRequestForCall,
  linkRequestsToCustomer,
  logRequestFailure,
  RequestPersistenceError
} from "./requests.js";

interface Recorded {
  table: string;
  op: "select" | "insert" | "update";
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
  isNull: string[];
}

type Reply = { data?: unknown; error?: unknown };

let calls: Recorded[] = [];
let replies: Record<string, Reply>;

function fakeClient() {
  return {
    from(table: string) {
      const call: Recorded = { table, op: "select", filters: {}, isNull: [] };
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
        is(column: string, _v: unknown) {
          call.isNull.push(column);
          return builder;
        },
        limit: () => builder,
        maybeSingle: finish,
        single: finish,
        then: (ok: (v: Reply) => unknown, err?: (e: unknown) => unknown) => finish().then(ok, err)
      };

      return builder;
    }
  };
}

const appointment = {
  businessId: "demo-shop",
  customerSmsConsent: false,
  customer: { name: "Dana", phone: "+14085551234" },
  vehicle: { year: 2019, make: "Toyota", model: "Camry" },
  service: "front_brake_pads",
  problemDescription: undefined,
  preferredDate: "2026-08-25",
  preferredTimeText: "morning"
};

const callback = {
  businessId: "demo-shop",
  customerSmsConsent: false,
  customer: { name: "Dana", phone: "+14085551234" },
  reason: "Wants to discuss the quote",
  preferredCallbackAt: "2026-08-20T14:00:00Z"
};

const find = (table: string, op: Recorded["op"]) =>
  calls.find((c) => c.table === table && c.op === op);

beforeEach(() => {
  calls = [];
  replies = {
    "appointment_requests.select": { data: null },
    "callback_requests.select": { data: null },
    "businesses.select": { data: { id: "demo-shop" } },
    "customers.select": { data: null },
    "customers.insert": { data: { id: "customer-1" } },
    "appointment_requests.insert": { data: { id: "appointment-1" } },
    "callback_requests.insert": { data: { id: "callback-1" } }
  };
  vi.mocked(getSupabase).mockImplementation(() => fakeClient() as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createAppointmentRequest", () => {
  it("creates the request and returns its id", async () => {
    const result = await createAppointmentRequest(appointment, {
      vapiToolCallId: "tc-1",
      vapiCallId: "vapi-call-1"
    });

    expect(result).toEqual({ requestId: "appointment-1", reused: false });
  });

  it("stores the request as pending, with no status of its own", async () => {
    await createAppointmentRequest(appointment, { vapiToolCallId: "tc-1" });

    // status is left to the column default, so nothing here can confirm it.
    expect(find("appointment_requests", "insert")?.payload).not.toHaveProperty("status");
  });

  it("stores the vehicle, service, and preferred date and time", async () => {
    await createAppointmentRequest(appointment, {
      vapiToolCallId: "tc-1",
      vapiCallId: "vapi-call-1"
    });

    expect(find("appointment_requests", "insert")?.payload).toEqual({
      business_id: "demo-shop",
      customer_id: "customer-1",
      vapi_call_id: "vapi-call-1",
      vapi_tool_call_id: "tc-1",
      vehicle_year: 2019,
      vehicle_make: "Toyota",
      vehicle_model: "Camry",
      service: "front_brake_pads",
      problem_description: null,
      preferred_date: "2026-08-25",
      preferred_time_text: "morning",
      customer_sms_consent: false,
      customer_sms_consent_at: null,
      customer_sms_consent_method: null,
      customer_sms_consent_scope: null
    });
  });

  it("stores a null call id when the payload had none", async () => {
    await createAppointmentRequest(appointment, { vapiToolCallId: "tc-1" });

    expect(find("appointment_requests", "insert")?.payload?.vapi_call_id).toBeNull();
  });

  it("reuses an existing customer matched by phone", async () => {
    replies["customers.select"] = { data: { id: "existing-customer", name: "Dana" } };

    await createAppointmentRequest(appointment, { vapiToolCallId: "tc-1" });

    expect(find("customers", "insert")).toBeUndefined();
    expect(find("appointment_requests", "insert")?.payload?.customer_id).toBe("existing-customer");
  });

  it("fills a missing customer name but never replaces one", async () => {
    replies["customers.select"] = { data: { id: "existing-customer", name: null } };

    await createAppointmentRequest(appointment, { vapiToolCallId: "tc-1" });

    expect(find("customers", "update")?.payload).toEqual({ name: "Dana" });
    expect(find("customers", "update")?.isNull).toContain("name");
  });

  it("leaves customer_id null when there is no phone number", async () => {
    await createAppointmentRequest(
      { ...appointment, customer: { name: "Dana" } },
      { vapiToolCallId: "tc-1" }
    );

    expect(find("customers", "select")).toBeUndefined();
    expect(find("customers", "insert")).toBeUndefined();
    expect(find("appointment_requests", "insert")?.payload?.customer_id).toBeNull();
  });

  it("returns the original request when the tool call is retried", async () => {
    replies["appointment_requests.select"] = { data: { id: "original-request" } };

    const result = await createAppointmentRequest(appointment, { vapiToolCallId: "tc-1" });

    expect(result).toEqual({ requestId: "original-request", reused: true });
    expect(find("appointment_requests", "insert")).toBeUndefined();
  });

  it("resolves a racing retry through the unique index", async () => {
    let lookups = 0;
    Object.defineProperty(replies, "appointment_requests.select", {
      get() {
        lookups += 1;
        return lookups === 1 ? { data: null } : { data: { id: "winner-request" } };
      },
      configurable: true
    });
    replies["appointment_requests.insert"] = { error: { code: "23505", message: "duplicate key" } };

    const result = await createAppointmentRequest(appointment, { vapiToolCallId: "tc-1" });

    expect(result).toEqual({ requestId: "winner-request", reused: true });
  });

  it("fails when the business does not exist, writing nothing", async () => {
    replies["businesses.select"] = { data: null };

    const err = await createAppointmentRequest(appointment, {}).catch((e) => e);

    expect(err).toBeInstanceOf(RequestPersistenceError);
    expect(err.step).toBe("ensureBusinessExists");
    expect(find("appointment_requests", "insert")).toBeUndefined();
  });

  it("fails when the insert errors", async () => {
    replies["appointment_requests.insert"] = { error: { code: "23502", message: "null value" } };

    const err = await createAppointmentRequest(appointment, {}).catch((e) => e);

    expect(err).toBeInstanceOf(RequestPersistenceError);
    expect(err.code).toBe("23502");
  });
});

describe("createCallbackRequest", () => {
  it("creates the request and returns its id", async () => {
    const result = await createCallbackRequest(callback, {
      vapiToolCallId: "tc-2",
      vapiCallId: "vapi-call-1"
    });

    expect(result).toEqual({ requestId: "callback-1", reused: false });
  });

  it("stores the reason and preferred callback time", async () => {
    await createCallbackRequest(callback, { vapiToolCallId: "tc-2", vapiCallId: "vapi-call-1" });

    expect(find("callback_requests", "insert")?.payload).toEqual({
      business_id: "demo-shop",
      customer_id: "customer-1",
      vapi_call_id: "vapi-call-1",
      vapi_tool_call_id: "tc-2",
      reason: "Wants to discuss the quote",
      preferred_callback_at: "2026-08-20T14:00:00Z",
      customer_sms_consent: false,
      customer_sms_consent_at: null,
      customer_sms_consent_method: null,
      customer_sms_consent_scope: null
    });
  });

  it("leaves the status to the column default", async () => {
    await createCallbackRequest(callback, { vapiToolCallId: "tc-2" });

    expect(find("callback_requests", "insert")?.payload).not.toHaveProperty("status");
  });

  it("allows a request with no phone number", async () => {
    const result = await createCallbackRequest(
      { businessId: "demo-shop", customerSmsConsent: false, reason: "Wants a call" },
      { vapiToolCallId: "tc-2" }
    );

    expect(result.requestId).toBe("callback-1");
    expect(find("callback_requests", "insert")?.payload?.customer_id).toBeNull();
  });

  it("returns the original request when the tool call is retried", async () => {
    replies["callback_requests.select"] = { data: { id: "original-callback" } };

    const result = await createCallbackRequest(callback, { vapiToolCallId: "tc-2" });

    expect(result).toEqual({ requestId: "original-callback", reused: true });
    expect(find("callback_requests", "insert")).toBeUndefined();
  });

  it("fails safely when the insert errors", async () => {
    replies["callback_requests.insert"] = { error: { code: "23503", message: "fk violation" } };

    const err = await createCallbackRequest(callback, {}).catch((e) => e);

    expect(err).toBeInstanceOf(RequestPersistenceError);
    expect(err.step).toBe("createCallbackRequest");
  });
});

describe("hasRequestForCall", () => {
  it("is true when the call produced a request", async () => {
    replies["appointment_requests.select"] = { data: [{ id: "appointment-1" }] };

    expect(await hasRequestForCall("appointment", "vapi-call-1")).toBe(true);
  });

  it("is false when it did not", async () => {
    replies["callback_requests.select"] = { data: [] };

    expect(await hasRequestForCall("callback", "vapi-call-1")).toBe(false);
  });
});

describe("linkRequestsToCustomer", () => {
  it("fills the customer on both kinds, only where blank", async () => {
    await linkRequestsToCustomer("vapi-call-1", "customer-1");

    for (const table of ["appointment_requests", "callback_requests"]) {
      const update = find(table, "update");
      expect(update?.payload).toMatchObject({ customer_id: "customer-1" });
      expect(update?.filters).toEqual({ vapi_call_id: "vapi-call-1" });
      // An existing customer is never overwritten.
      expect(update?.isNull).toContain("customer_id");
    }
  });
});

describe("PII-safe failure logging", () => {
  it("records the ids and the code, never the personal fields", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => {
      logged.push(String(msg));
    });
    replies["appointment_requests.insert"] = { error: { code: "23502", message: "null value" } };

    const err = await createAppointmentRequest(appointment, { vapiToolCallId: "tc-1" }).catch((e) => e);
    logRequestFailure(err, {
      kind: "appointment",
      toolCallId: "tc-1",
      vapiCallId: "vapi-call-1",
      businessId: "demo-shop"
    });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("kind=appointment");
    expect(logged[0]).toContain('code="23502"');
    expect(logged[0]).toContain('toolCallId="tc-1"');
    expect(logged[0]).toContain('businessId="demo-shop"');
    expect(logged[0]).not.toContain("+14085551234");
    expect(logged[0]).not.toContain("Dana");
    expect(logged[0]).not.toContain("front_brake_pads");
  });
});

describe("SMS consent evidence", () => {
  const consentColumns = (table: string) => {
    const payload = calls.find((c) => c.table === table && c.op === "insert")?.payload ?? {};
    return {
      consent: payload.customer_sms_consent,
      at: payload.customer_sms_consent_at,
      method: payload.customer_sms_consent_method,
      scope: payload.customer_sms_consent_scope
    };
  };

  describe("appointment requests", () => {
    it("stores consent as true when the caller agreed", async () => {
      await createAppointmentRequest({ ...appointment, customerSmsConsent: true }, {});

      expect(consentColumns("appointment_requests").consent).toBe(true);
    });

    it("stores a server timestamp, not one from the caller", async () => {
      const before = Date.now();
      await createAppointmentRequest({ ...appointment, customerSmsConsent: true }, {});
      const after = Date.now();

      const at = consentColumns("appointment_requests").at as string;
      expect(typeof at).toBe("string");
      const recorded = new Date(at).getTime();
      expect(recorded).toBeGreaterThanOrEqual(before);
      expect(recorded).toBeLessThanOrEqual(after);
    });

    it('stores method "voice"', async () => {
      await createAppointmentRequest({ ...appointment, customerSmsConsent: true }, {});

      expect(consentColumns("appointment_requests").method).toBe("voice");
    });

    it('stores scope "request_confirmation"', async () => {
      await createAppointmentRequest({ ...appointment, customerSmsConsent: true }, {});

      expect(consentColumns("appointment_requests").scope).toBe("request_confirmation");
    });

    it("stores false when consent was not given", async () => {
      await createAppointmentRequest({ ...appointment, customerSmsConsent: false }, {});

      expect(consentColumns("appointment_requests").consent).toBe(false);
    });

    it("leaves the audit columns null when consent was not given", async () => {
      await createAppointmentRequest({ ...appointment, customerSmsConsent: false }, {});

      const { at, method, scope } = consentColumns("appointment_requests");
      expect(at).toBeNull();
      expect(method).toBeNull();
      expect(scope).toBeNull();
    });

    it("ignores a timestamp or method supplied by the caller", async () => {
      await createAppointmentRequest(
        {
          ...appointment,
          customerSmsConsent: true,
          // A tool could try to dictate its own evidence. It must not win.
          customer_sms_consent_at: "1999-01-01T00:00:00Z",
          customerSmsConsentAt: "1999-01-01T00:00:00Z",
          customerSmsConsentMethod: "manual",
          customerSmsConsentScope: "marketing"
        } as never,
        {}
      );

      const { at, method, scope } = consentColumns("appointment_requests");
      expect(at).not.toBe("1999-01-01T00:00:00Z");
      expect(new Date(at as string).getFullYear()).toBeGreaterThan(2020);
      expect(method).toBe("voice");
      expect(scope).toBe("request_confirmation");
    });
  });

  describe("callback requests", () => {
    it("stores the full evidence when the caller agreed", async () => {
      await createCallbackRequest({ ...callback, customerSmsConsent: true }, {});

      const { consent, at, method, scope } = consentColumns("callback_requests");
      expect(consent).toBe(true);
      expect(typeof at).toBe("string");
      expect(method).toBe("voice");
      expect(scope).toBe("request_confirmation");
    });

    it("stores false and null audit columns without consent", async () => {
      await createCallbackRequest({ ...callback, customerSmsConsent: false }, {});

      const { consent, at, method, scope } = consentColumns("callback_requests");
      expect(consent).toBe(false);
      expect(at).toBeNull();
      expect(method).toBeNull();
      expect(scope).toBeNull();
    });

    it("ignores caller-supplied evidence", async () => {
      await createCallbackRequest(
        { ...callback, customerSmsConsent: true, customerSmsConsentMethod: "manual" } as never,
        {}
      );

      expect(consentColumns("callback_requests").method).toBe("voice");
    });
  });

  describe("retries", () => {
    it("returns the original appointment without rewriting its consent", async () => {
      replies["appointment_requests.select"] = { data: { id: "original-request" } };

      const result = await createAppointmentRequest(
        { ...appointment, customerSmsConsent: true },
        { vapiToolCallId: "tc-1" }
      );

      expect(result).toEqual({ requestId: "original-request", reused: true });
      // No insert and no update, so the stored evidence is untouched.
      expect(calls.some((c) => c.table === "appointment_requests" && c.op !== "select")).toBe(false);
    });

    it("returns the original callback without rewriting its consent", async () => {
      replies["callback_requests.select"] = { data: { id: "original-callback" } };

      const result = await createCallbackRequest(
        { ...callback, customerSmsConsent: true },
        { vapiToolCallId: "tc-2" }
      );

      expect(result.reused).toBe(true);
      expect(calls.some((c) => c.table === "callback_requests" && c.op !== "select")).toBe(false);
    });
  });
});

