import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Supabase client itself, so persistEstimate's real logic runs while
// nothing touches the network.
vi.mock("./supabase.js", () => ({ getSupabase: vi.fn() }));

import { getSupabase } from "./supabase.js";
import { persistEstimate, PersistenceError } from "./estimates.js";
import type { Estimate } from "../pricing/estimate.js";

/** One recorded query, so tests can assert what the database was asked to do. */
interface RecordedCall {
  table: string;
  op: "select" | "insert";
  payload?: Record<string, unknown>;
  filters: Record<string, unknown>;
}

type Reply = { data?: unknown; error?: unknown };

interface Replies {
  businessSelect: Reply;
  vehicleInsert: Reply;
  estimateInsert: Reply;
  estimateSelect: Reply;
}

let calls: RecordedCall[] = [];
let replies: Replies;

/** Picks the configured reply for whichever query is being run. */
function replyFor(call: RecordedCall): Reply {
  if (call.table === "businesses") return replies.businessSelect;
  if (call.table === "vehicles") return replies.vehicleInsert;
  return call.op === "insert" ? replies.estimateInsert : replies.estimateSelect;
}

/**
 * The smallest thing that behaves like the Supabase query builder for the four
 * queries this module makes. It is thenable because the estimates insert is
 * awaited directly, with no .single() on the end.
 */
function fakeClient() {
  return {
    from(table: string) {
      const call: RecordedCall = { table, op: "select", filters: {} };

      const finish = () => {
        calls.push(call);
        return Promise.resolve(replyFor(call));
      };

      const builder = {
        select() {
          return builder;
        },
        insert(payload: Record<string, unknown>) {
          call.op = "insert";
          call.payload = payload;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters[column] = value;
          return builder;
        },
        maybeSingle: finish,
        single: finish,
        then(onOk: (v: Reply) => unknown, onErr?: (e: unknown) => unknown) {
          return finish().then(onOk, onErr);
        }
      };

      return builder;
    }
  };
}

const estimate: Estimate = {
  estimateType: "preliminary",
  service: "front_brake_pads",
  vehicle: { year: 2019, make: "Toyota", model: "Camry" },
  low: 300,
  high: 450,
  currency: "USD",
  disclaimer: "Final pricing is subject to vehicle inspection."
};

const baseInput = {
  estimateId: "new-estimate-id",
  businessId: "demo-shop",
  vehicle: estimate.vehicle,
  estimate
};

const tablesTouched = () => calls.map((c) => `${c.table}.${c.op}`);

beforeEach(() => {
  calls = [];
  replies = {
    businessSelect: { data: { id: "demo-shop" } },
    vehicleInsert: { data: { id: "vehicle-uuid-1" } },
    estimateInsert: {},
    estimateSelect: { data: null }
  };
  vi.mocked(getSupabase).mockImplementation(() => fakeClient() as never);
  // Failures are logged; keep the test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("persistEstimate — new Vapi tool call", () => {
  it("checks the business, creates the vehicle, then saves the estimate", async () => {
    const result = await persistEstimate({
      ...baseInput,
      source: "vapi",
      vapiToolCallId: "call_new_1"
    });

    expect(tablesTouched()).toEqual([
      "estimates.select", // retry check
      "businesses.select", // business exists?
      "vehicles.insert",
      "estimates.insert"
    ]);
    expect(result).toEqual({ estimateId: "new-estimate-id", reused: false });
  });

  it("writes the expected estimate row", async () => {
    await persistEstimate({ ...baseInput, source: "vapi", vapiToolCallId: "call_new_2" });

    const row = calls.find((c) => c.table === "estimates" && c.op === "insert")?.payload;
    expect(row).toMatchObject({
      id: "new-estimate-id",
      business_id: "demo-shop",
      vehicle_id: "vehicle-uuid-1",
      service: "front_brake_pads",
      low_price: 300,
      high_price: 450,
      currency: "USD",
      source: "vapi",
      vapi_tool_call_id: "call_new_2"
    });
  });

  it("records the Vapi call id when the tool payload had one", async () => {
    await persistEstimate({
      ...baseInput,
      source: "vapi",
      vapiToolCallId: "call_new_4",
      vapiCallId: "vapi-call-xyz"
    });

    const row = calls.find((c) => c.table === "estimates" && c.op === "insert")?.payload;
    expect(row?.vapi_call_id).toBe("vapi-call-xyz");
  });

  it("stores a null call id when there was none", async () => {
    await persistEstimate({ ...baseInput, source: "api" });

    const row = calls.find((c) => c.table === "estimates" && c.op === "insert")?.payload;
    expect(row?.vapi_call_id).toBeNull();
  });

  it("writes the vehicle with no customer", async () => {
    await persistEstimate({ ...baseInput, source: "vapi", vapiToolCallId: "call_new_3" });

    const row = calls.find((c) => c.table === "vehicles")?.payload;
    expect(row).toEqual({
      business_id: "demo-shop",
      year: 2019,
      make: "Toyota",
      model: "Camry"
    });
  });
});

describe("persistEstimate — repeated Vapi tool call", () => {
  beforeEach(() => {
    // The tool call id is already stored from the first attempt.
    replies.estimateSelect = { data: { id: "original-estimate-id" } };
  });

  it("returns the original estimateId", async () => {
    const result = await persistEstimate({
      ...baseInput,
      source: "vapi",
      vapiToolCallId: "call_repeat_1"
    });

    expect(result).toEqual({ estimateId: "original-estimate-id", reused: true });
  });

  it("creates no second vehicle and no second estimate", async () => {
    await persistEstimate({ ...baseInput, source: "vapi", vapiToolCallId: "call_repeat_2" });

    expect(tablesTouched()).toEqual(["estimates.select"]);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });
});

describe("persistEstimate — two retries racing", () => {
  beforeEach(() => {
    // Both attempts miss the lookup, then one insert loses to the unique index.
    let selectCount = 0;
    replies.estimateInsert = { error: { code: "23505", message: "duplicate key value" } };
    Object.defineProperty(replies, "estimateSelect", {
      get() {
        // First lookup finds nothing; the one after the conflict finds the winner.
        selectCount += 1;
        return selectCount === 1 ? { data: null } : { data: { id: "winner-estimate-id" } };
      },
      configurable: true
    });
  });

  it("re-reads the winning row and returns its estimateId", async () => {
    const result = await persistEstimate({
      ...baseInput,
      source: "vapi",
      vapiToolCallId: "call_race_1"
    });

    expect(result).toEqual({ estimateId: "winner-estimate-id", reused: true });
  });

  it("reports no duplicate estimate to the caller", async () => {
    const result = await persistEstimate({
      ...baseInput,
      source: "vapi",
      vapiToolCallId: "call_race_2"
    });

    // Exactly one estimate insert was attempted, and it did not win.
    expect(calls.filter((c) => c.table === "estimates" && c.op === "insert")).toHaveLength(1);
    expect(result.reused).toBe(true);
    expect(result.estimateId).not.toBe("new-estimate-id");
  });

  it("still fails if the conflict cannot be resolved to a row", async () => {
    Object.defineProperty(replies, "estimateSelect", {
      value: { data: null },
      configurable: true
    });

    await expect(
      persistEstimate({ ...baseInput, source: "vapi", vapiToolCallId: "call_race_3" })
    ).rejects.toBeInstanceOf(PersistenceError);
  });
});

describe("persistEstimate — direct API estimate", () => {
  it("skips the retry lookup and runs the normal path", async () => {
    const result = await persistEstimate({ ...baseInput, source: "api" });

    expect(tablesTouched()).toEqual([
      "businesses.select",
      "vehicles.insert",
      "estimates.insert"
    ]);
    expect(result).toEqual({ estimateId: "new-estimate-id", reused: false });
  });

  it("stores a null tool call id", async () => {
    await persistEstimate({ ...baseInput, source: "api" });

    const row = calls.find((c) => c.table === "estimates" && c.op === "insert")?.payload;
    expect(row?.vapi_tool_call_id).toBeNull();
    expect(row?.source).toBe("api");
  });
});

describe("persistEstimate — failures propagate safely", () => {
  it("fails when the business lookup errors", async () => {
    replies.businessSelect = { error: { code: "PGRST301", message: "permission denied" } };

    const err = await persistEstimate({ ...baseInput, source: "api" }).catch((e) => e);

    expect(err).toBeInstanceOf(PersistenceError);
    expect(err.step).toBe("ensureBusinessExists");
    expect(err.code).toBe("PGRST301");
    // Nothing was written.
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("fails when the business does not exist", async () => {
    replies.businessSelect = { data: null };

    const err = await persistEstimate({
      ...baseInput,
      businessId: "no-such-shop",
      source: "api"
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PersistenceError);
    expect(err.step).toBe("ensureBusinessExists");
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("fails when the vehicle insert errors", async () => {
    replies.vehicleInsert = { error: { code: "23503", message: "foreign key violation" } };

    const err = await persistEstimate({ ...baseInput, source: "api" }).catch((e) => e);

    expect(err).toBeInstanceOf(PersistenceError);
    expect(err.step).toBe("createVehicle");
    expect(err.code).toBe("23503");
    // The estimate was never attempted.
    expect(calls.some((c) => c.table === "estimates")).toBe(false);
  });

  it("fails when the estimate insert errors", async () => {
    replies.estimateInsert = { error: { code: "23502", message: "null value not allowed" } };

    const err = await persistEstimate({ ...baseInput, source: "api" }).catch((e) => e);

    expect(err).toBeInstanceOf(PersistenceError);
    expect(err.step).toBe("saveEstimate");
    expect(err.code).toBe("23502");
  });

  it("does not treat a non-Vapi unique violation as a retry", async () => {
    replies.estimateInsert = { error: { code: "23505", message: "duplicate key value" } };

    // No vapiToolCallId, so there is nothing to reconcile against.
    const err = await persistEstimate({ ...baseInput, source: "api" }).catch((e) => e);

    expect(err).toBeInstanceOf(PersistenceError);
    expect(err.step).toBe("saveEstimate");
  });

  it("logs a failure without leaking the row contents", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg) => {
      logged.push(String(msg));
    });
    replies.businessSelect = { error: { code: "PGRST301", message: "permission denied" } };

    await persistEstimate({ ...baseInput, source: "api" }).catch(() => undefined);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("step=ensureBusinessExists");
    expect(logged[0]).toContain("status=FAIL");
    expect(logged[0]).toContain('code="PGRST301"');
    expect(logged[0]).toContain('businessId="demo-shop"');
    expect(logged[0]).toContain('service="front_brake_pads"');
  });
});
