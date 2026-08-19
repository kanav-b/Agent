import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Supabase client so persistCall's real logic runs with no network.
vi.mock("./supabase.js", () => ({ getSupabase: vi.fn() }));

import { getSupabase } from "./supabase.js";
import { CallPersistenceError, persistCall } from "./calls.js";
import type { NormalizedCall } from "../calls/normalize.js";

interface RecordedCall {
  table: string;
  op: "select" | "insert" | "upsert" | "update";
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
  isNull: string[];
}

type Reply = { data?: unknown; error?: unknown };

let calls: RecordedCall[] = [];
let replies: Record<string, Reply>;

/** Chooses the configured reply for whichever query is running. */
function replyFor(call: RecordedCall): Reply {
  const key = `${call.table}.${call.op}`;
  return replies[key] ?? {};
}

function fakeClient() {
  return {
    from(table: string) {
      const call: RecordedCall = { table, op: "select", filters: {}, isNull: [] };

      const finish = () => {
        calls.push(call);
        return Promise.resolve(replyFor(call));
      };

      const builder = {
        select: () => builder,
        insert(payload: Record<string, unknown>) {
          call.op = "insert";
          call.payload = payload;
          return builder;
        },
        upsert(payload: Record<string, unknown>) {
          call.op = "upsert";
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
        is(column: string, _value: unknown) {
          call.isNull.push(column);
          return builder;
        },
        maybeSingle: finish,
        single: finish,
        then: (onOk: (v: Reply) => unknown, onErr?: (e: unknown) => unknown) =>
          finish().then(onOk, onErr)
      };

      return builder;
    }
  };
}

const baseCall: NormalizedCall = {
  vapiCallId: "vapi-call-1",
  businessId: "demo-shop",
  callerPhone: "+14085551234",
  customerName: "Dana",
  startedAt: "2026-08-19T10:00:00.000Z",
  endedAt: "2026-08-19T10:04:30.000Z",
  endedReason: "customer-ended-call",
  transcript: "User: Hi",
  summary: "Asked about brakes.",
  outcome: "information_only",
  requiresFollowUp: false
};

const find = (table: string, op: RecordedCall["op"]) =>
  calls.find((c) => c.table === table && c.op === op);

beforeEach(() => {
  calls = [];
  replies = {
    "calls.select": { data: null }, // not seen before
    "businesses.select": { data: { id: "demo-shop" } },
    "customers.select": { data: null }, // caller unknown
    "customers.insert": { data: { id: "customer-uuid-1" } },
    "calls.upsert": {},
    "estimates.update": {}
  };
  vi.mocked(getSupabase).mockImplementation(() => fakeClient() as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("persistCall — new call from a new caller", () => {
  it("creates the customer and stores the call", async () => {
    const result = await persistCall(baseCall);

    expect(result).toEqual({ duplicate: false, customerId: "customer-uuid-1" });
    expect(find("customers", "insert")).toBeDefined();
    expect(find("calls", "upsert")).toBeDefined();
  });

  it("stores the Vapi call id, phone, times, reason, transcript, and summary", async () => {
    await persistCall(baseCall);

    expect(find("calls", "upsert")?.payload).toEqual({
      business_id: "demo-shop",
      vapi_call_id: "vapi-call-1",
      customer_id: "customer-uuid-1",
      caller_phone: "+14085551234",
      started_at: "2026-08-19T10:00:00.000Z",
      ended_at: "2026-08-19T10:04:30.000Z",
      ended_reason: "customer-ended-call",
      transcript: "User: Hi",
      summary: "Asked about brakes.",
      outcome: "information_only",
      requires_follow_up: false
    });
  });

  it("creates the customer with the phone and name from the call", async () => {
    await persistCall(baseCall);

    expect(find("customers", "insert")?.payload).toEqual({
      business_id: "demo-shop",
      phone: "+14085551234",
      name: "Dana"
    });
  });

  it("looks the caller up by business and phone", async () => {
    await persistCall(baseCall);

    expect(find("customers", "select")?.filters).toEqual({
      business_id: "demo-shop",
      phone: "+14085551234"
    });
  });
});

describe("persistCall — caller already known", () => {
  it("reuses the existing customer and creates no new one", async () => {
    replies["customers.select"] = { data: { id: "existing-customer", name: "Dana" } };

    const result = await persistCall(baseCall);

    expect(result.customerId).toBe("existing-customer");
    expect(find("customers", "insert")).toBeUndefined();
  });

  it("fills in a missing name", async () => {
    replies["customers.select"] = { data: { id: "existing-customer", name: null } };

    await persistCall(baseCall);

    const update = find("customers", "update");
    expect(update?.payload).toEqual({ name: "Dana" });
    // Guarded in the query itself, so a name added meanwhile is not clobbered.
    expect(update?.isNull).toContain("name");
  });

  it("does not touch an existing name", async () => {
    replies["customers.select"] = { data: { id: "existing-customer", name: "Existing Name" } };

    await persistCall(baseCall);

    expect(find("customers", "update")).toBeUndefined();
  });

  it("does not update when the report carries no name", async () => {
    replies["customers.select"] = { data: { id: "existing-customer", name: null } };

    await persistCall({ ...baseCall, customerName: null });

    expect(find("customers", "update")).toBeUndefined();
  });
});

describe("persistCall — no phone number", () => {
  it("stores the call with no customer and invents nothing", async () => {
    const result = await persistCall({ ...baseCall, callerPhone: null });

    expect(result.customerId).toBeNull();
    expect(find("customers", "select")).toBeUndefined();
    expect(find("customers", "insert")).toBeUndefined();
    expect(find("calls", "upsert")?.payload).toMatchObject({
      caller_phone: null,
      customer_id: null
    });
  });

  it("does not try to link estimates without a customer", async () => {
    await persistCall({ ...baseCall, callerPhone: null });

    expect(find("estimates", "update")).toBeUndefined();
  });
});

describe("persistCall — repeated end-of-call report", () => {
  beforeEach(() => {
    replies["calls.select"] = { data: { id: "existing-call-row" } };
    replies["customers.select"] = { data: { id: "existing-customer", name: "Dana" } };
  });

  it("reports the call as a duplicate", async () => {
    const result = await persistCall(baseCall);

    expect(result.duplicate).toBe(true);
  });

  it("writes through an upsert rather than a second insert", async () => {
    await persistCall(baseCall);

    expect(find("calls", "upsert")).toBeDefined();
    expect(find("calls", "insert")).toBeUndefined();
    expect(calls.filter((c) => c.table === "calls" && c.op === "upsert")).toHaveLength(1);
  });

  it("does not send created_at, so the original is kept", async () => {
    await persistCall(baseCall);

    expect(find("calls", "upsert")?.payload).not.toHaveProperty("created_at");
  });
});

describe("persistCall — linking estimates to the caller", () => {
  it("fills in the customer on estimates from this call", async () => {
    await persistCall(baseCall);

    const update = find("estimates", "update");
    expect(update?.payload).toEqual({ customer_id: "customer-uuid-1" });
    expect(update?.filters).toEqual({ vapi_call_id: "vapi-call-1" });
    // Only blanks: an estimate that already has a customer is left alone.
    expect(update?.isNull).toContain("customer_id");
  });

  it("never changes estimate pricing", async () => {
    await persistCall(baseCall);

    const update = find("estimates", "update");
    expect(Object.keys(update?.payload ?? {})).toEqual(["customer_id"]);
  });
});

describe("persistCall — failures", () => {
  it("fails safely when the call lookup errors", async () => {
    replies["calls.select"] = { error: { code: "PGRST301", message: "permission denied" } };

    const err = await persistCall(baseCall).catch((e) => e);

    expect(err).toBeInstanceOf(CallPersistenceError);
    expect(err.step).toBe("findCallByVapiId");
    expect(err.code).toBe("PGRST301");
  });

  it("fails when the business does not exist, before writing anything", async () => {
    replies["businesses.select"] = { data: null };

    const err = await persistCall(baseCall).catch((e) => e);

    expect(err).toBeInstanceOf(CallPersistenceError);
    expect(err.step).toBe("ensureBusinessExists");
    expect(calls.some((c) => c.op === "insert" || c.op === "upsert")).toBe(false);
  });

  it("fails when the customer insert errors", async () => {
    replies["customers.insert"] = { error: { code: "23503", message: "fk violation" } };

    const err = await persistCall(baseCall).catch((e) => e);

    expect(err.step).toBe("createCustomer");
    expect(find("calls", "upsert")).toBeUndefined();
  });

  it("fails when the call upsert errors", async () => {
    replies["calls.upsert"] = { error: { code: "23502", message: "null value" } };

    const err = await persistCall(baseCall).catch((e) => e);

    expect(err.step).toBe("saveCall");
    expect(err.code).toBe("23502");
  });
});

describe("PII-safe failure logging", () => {
  it("logs the step, code, call id and business — and no personal data", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => {
      logged.push(String(msg));
    });

    const { logCallFailure } = await import("./calls.js");
    replies["calls.upsert"] = { error: { code: "23502", message: "null value in column" } };

    const err = await persistCall(baseCall).catch((e) => e);
    logCallFailure(err, { vapiCallId: baseCall.vapiCallId, businessId: baseCall.businessId });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("step=saveCall");
    expect(logged[0]).toContain('code="23502"');
    expect(logged[0]).toContain('vapiCallId="vapi-call-1"');
    expect(logged[0]).toContain('businessId="demo-shop"');
    // The things that must never be logged.
    expect(logged[0]).not.toContain("+14085551234");
    expect(logged[0]).not.toContain("Dana");
    expect(logged[0]).not.toContain("User: Hi");
    expect(logged[0]).not.toContain("Asked about brakes");
  });
});
