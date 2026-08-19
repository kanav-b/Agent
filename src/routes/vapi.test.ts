import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// The database is replaced with a stub, so these tests never reach the network
// and never need Supabase credentials.
vi.mock("../db/estimates.js", () => ({
  persistEstimate: vi.fn()
}));

import { createApp } from "../app.js";
import { persistEstimate } from "../db/estimates.js";
import { VAPI_SECRET_HEADER } from "../middleware/vapiAuth.js";

const mockPersist = vi.mocked(persistEstimate);

// A fake secret for tests only. The real one lives in .env and is never here.
const TEST_SECRET = "test-vapi-secret-not-real";
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = TEST_SECRET;

const app = createApp();

beforeEach(() => {
  mockPersist.mockReset();
  mockPersist.mockImplementation(async (input) => ({
    estimateId: input.estimateId,
    reused: false
  }));
});

const ROUTE = "/api/vapi/tools/estimate";

/** Posts an authorised Vapi tool call. Auth itself is tested separately. */
const postTool = (body: object) =>
  request(app).post(ROUTE).set(VAPI_SECRET_HEADER, TEST_SECRET).send(body);

const vehicle = { year: 2019, make: "Toyota", model: "Camry" };

/** Builds a Vapi tool-call envelope around one set of arguments. */
function envelope(
  toolCall: Record<string, unknown>,
  { id = "call_123", name = "calculate_estimate" } = {}
) {
  return {
    message: {
      type: "tool-calls",
      toolCallList: [{ id, name, ...toolCall }]
    }
  };
}

const validCall = envelope({
  arguments: { businessId: "demo-shop", service: "front_brake_pads", vehicle }
});

describe("POST /api/vapi/tools/estimate", () => {
  it("handles a successful calculate_estimate call", async () => {
    const res = await postTool(validCall);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results).toHaveLength(1);
  });

  it("echoes back the same toolCallId", async () => {
    const res = await postTool(envelope({ arguments: { service: "front_brake_pads", vehicle } }, { id: "call_abc_789" }));

    expect(res.body.results[0].toolCallId).toBe("call_abc_789");
  });

  it("returns result as a single-line string", async () => {
    const res = await postTool(validCall);
    const { result } = res.body.results[0];

    expect(typeof result).toBe("string");
    expect(result).not.toContain("\n");
  });

  it("returns a result string that parses as JSON", async () => {
    const res = await postTool(validCall);

    expect(() => JSON.parse(res.body.results[0].result)).not.toThrow();
  });

  it("includes an estimateId in the parsed result", async () => {
    const res = await postTool(validCall);
    const parsed = JSON.parse(res.body.results[0].result);

    expect(parsed.estimateId).toBeTypeOf("string");
    expect(parsed.estimateId.length).toBeGreaterThan(0);
  });

  it("returns low 300 and high 450 for front_brake_pads", async () => {
    const res = await postTool(validCall);
    const parsed = JSON.parse(res.body.results[0].result);

    expect(parsed.low).toBe(300);
    expect(parsed.high).toBe(450);
  });

  it("includes the expected disclaimer", async () => {
    const res = await postTool(validCall);
    const parsed = JSON.parse(res.body.results[0].result);

    expect(parsed.disclaimer).toBe("Final pricing is subject to vehicle inspection.");
  });

  it("matches the prices returned by POST /api/estimate", async () => {
    const viaVapi = await postTool(validCall);
    const viaRest = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    const parsed = JSON.parse(viaVapi.body.results[0].result);
    expect(parsed.low).toBe(viaRest.body.low);
    expect(parsed.high).toBe(viaRest.body.high);
  });

  it("also accepts arguments sent as `parameters`", async () => {
    const res = await postTool(envelope({ parameters: { service: "front_brake_pads", vehicle } }));

    const parsed = JSON.parse(res.body.results[0].result);
    expect(parsed.low).toBe(300);
  });

  it("works without businessId", async () => {
    const res = await postTool(envelope({ arguments: { service: "front_brake_pads", vehicle } }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].result).toBeTypeOf("string");
  });

  it("returns 200 with a tool-level error for an unsupported service", async () => {
    const res = await postTool(envelope({ arguments: { service: "engine_rebuild", vehicle } }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].toolCallId).toBe("call_123");
    expect(res.body.results[0].error).toMatch(/not supported/);
    expect(res.body.results[0].result).toBeUndefined();
  });

  it("returns 200 with a tool-level error for malformed parameters", async () => {
    const res = await postTool(envelope({ arguments: { service: "front_brake_pads" } }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].toolCallId).toBe("call_123");
    expect(res.body.results[0].error).toMatch(/Invalid estimate parameters/);
  });

  it("returns 200 with a tool-level error for an unsupported tool name", async () => {
    const res = await postTool(
        envelope(
          { arguments: { service: "front_brake_pads", vehicle } },
          { name: "book_appointment" }
        )
      );

    expect(res.status).toBe(200);
    expect(res.body.results[0].toolCallId).toBe("call_123");
    expect(res.body.results[0].error).toMatch(/Unsupported tool/);
  });

  it("never leaks internals in an error message", async () => {
    const res = await postTool(envelope({ arguments: { service: "engine_rebuild", vehicle } }));

    const { error } = res.body.results[0];
    expect(error).not.toMatch(/at \/|\.ts:|Error:/);
  });

  it("rejects a malformed envelope with no usable toolCallId", async () => {
    const res = await postTool({ nonsense: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid Vapi tool-call request body.");
  });

  it("rejects an envelope with the wrong message type", async () => {
    const res = await postTool({ message: { type: "status-update", toolCallList: [] } });

    expect(res.status).toBe(400);
  });

  it("rejects an envelope with an empty toolCallList", async () => {
    const res = await postTool({ message: { type: "tool-calls", toolCallList: [] } });

    expect(res.status).toBe(400);
  });

  it("rejects a tool call with no name in either position", async () => {
    const res = await postTool({
        message: {
          type: "tool-calls",
          toolCallList: [{ id: "call_123", arguments: { service: "front_brake_pads", vehicle } }]
        }
      });

    expect(res.status).toBe(400);
  });

  it("ignores extra Vapi fields such as toolWithToolCallList", async () => {
    const res = await postTool({
        message: {
          timestamp: 1678901234567,
          type: "tool-calls",
          toolCallList: [
            {
              id: "call_123",
              name: "calculate_estimate",
              arguments: { service: "front_brake_pads", vehicle }
            }
          ],
          toolWithToolCallList: [
            {
              type: "function",
              name: "calculate_estimate",
              description: "Calculates an estimate",
              parameters: { type: "object", properties: {} }
            }
          ]
        }
      });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body.results[0].result).low).toBe(300);
  });
});

/**
 * Vapi also emits an OpenAI-style shape where the name and arguments live
 * under `function`. This is what caused a live "Invalid Vapi tool-call request
 * body." error before the adapter understood it.
 */
describe("POST /api/vapi/tools/estimate (nested function shape)", () => {
  function nestedEnvelope(fn: Record<string, unknown>, id = "call_123") {
    return { message: { type: "tool-calls", toolCallList: [{ id, function: fn }] } };
  }

  it("reads the tool name from function.name", async () => {
    const res = await postTool(
        nestedEnvelope({
          name: "calculate_estimate",
          arguments: { service: "front_brake_pads", vehicle }
        })
      );

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toBeUndefined();
  });

  it("reads an object from function.arguments", async () => {
    const res = await postTool(
        nestedEnvelope({
          name: "calculate_estimate",
          arguments: { businessId: "demo-shop", service: "front_brake_pads", vehicle }
        })
      );

    const parsed = JSON.parse(res.body.results[0].result);
    expect(parsed.low).toBe(300);
    expect(parsed.high).toBe(450);
    expect(parsed.estimateId).toBeTypeOf("string");
  });

  it("reads a JSON string from function.arguments", async () => {
    const res = await postTool(
        nestedEnvelope({
          name: "calculate_estimate",
          arguments: JSON.stringify({ service: "front_brake_pads", vehicle })
        })
      );

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body.results[0].result);
    expect(parsed.low).toBe(300);
    expect(parsed.high).toBe(450);
  });

  it("echoes the correct toolCallId for the nested shape", async () => {
    const res = await postTool(
        nestedEnvelope(
          { name: "calculate_estimate", arguments: { service: "front_brake_pads", vehicle } },
          "call_nested_456"
        )
      );

    expect(res.body.results[0].toolCallId).toBe("call_nested_456");
  });

  it("returns a tool-level error for an unsupported nested tool name", async () => {
    const res = await postTool(nestedEnvelope({ name: "book_appointment", arguments: { service: "front_brake_pads", vehicle } }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].toolCallId).toBe("call_123");
    expect(res.body.results[0].error).toMatch(/Unsupported tool/);
  });

  it("returns a tool-level error for an unsupported nested service", async () => {
    const res = await postTool(
        nestedEnvelope({ name: "calculate_estimate", arguments: { service: "engine_rebuild", vehicle } })
      );

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toMatch(/not supported/);
  });

  it("returns a tool-level error for unparseable JSON-string arguments", async () => {
    const res = await postTool(nestedEnvelope({ name: "calculate_estimate", arguments: "{not valid json" }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toMatch(/Invalid estimate parameters/);
  });

  // Captured from a real Vapi call. It carries the same tool call twice, in
  // `toolCalls` and `toolCallList`, and tags each one with `type: "function"`.
  // Only toolCallList is read, so the duplicate must not be processed twice.
  it("handles the exact payload captured from a live Vapi call", async () => {
    const toolCall = {
      id: "call_example",
      type: "function",
      function: {
        name: "calculate_estimate",
        arguments: {
          service: "front_brake_pads",
          vehicle: { make: "Toyota", year: 2019, model: "Camry" },
          businessId: "demo-shop"
        }
      }
    };

    const res = await postTool({ message: { type: "tool-calls", toolCalls: [toolCall], toolCallList: [toolCall] } });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].toolCallId).toBe("call_example");
    expect(res.body.results[0].error).toBeUndefined();

    const parsed = JSON.parse(res.body.results[0].result);
    expect(parsed.low).toBe(300);
    expect(parsed.high).toBe(450);
  });

  it("gives the same prices as the flat shape", async () => {
    const nested = await postTool(
        nestedEnvelope({ name: "calculate_estimate", arguments: { service: "front_brake_pads", vehicle } })
      );
    const flat = await postTool(validCall);

    const fromNested = JSON.parse(nested.body.results[0].result);
    const fromFlat = JSON.parse(flat.body.results[0].result);

    expect(fromNested.low).toBe(fromFlat.low);
    expect(fromNested.high).toBe(fromFlat.high);
  });
});

describe("POST /api/vapi/tools/estimate persistence", () => {
  it("saves the estimate before replying to Vapi", async () => {
    const res = await postTool(validCall);

    expect(res.status).toBe(200);
    expect(mockPersist).toHaveBeenCalledTimes(1);
  });

  it('persists source "vapi"', async () => {
    await postTool(validCall);

    expect(mockPersist.mock.calls[0][0].source).toBe("vapi");
  });

  it("persists the Vapi toolCallId", async () => {
    await postTool(envelope({ arguments: { service: "front_brake_pads", vehicle } }, { id: "call_xyz_1" }));

    expect(mockPersist.mock.calls[0][0].vapiToolCallId).toBe("call_xyz_1");
  });

  it("passes the businessId and vehicle", async () => {
    await postTool(validCall);

    const input = mockPersist.mock.calls[0][0];
    expect(input.businessId).toBe("demo-shop");
    expect(input.vehicle).toEqual(vehicle);
  });

  it("persists the same estimateId it returns", async () => {
    const res = await postTool(validCall);

    const returned = JSON.parse(res.body.results[0].result).estimateId;
    expect(mockPersist.mock.calls[0][0].estimateId).toBe(returned);
  });

  it("returns the stored estimateId when a retry is detected", async () => {
    mockPersist.mockResolvedValueOnce({ estimateId: "original-id-from-first-call", reused: true });

    const res = await postTool(validCall);

    expect(JSON.parse(res.body.results[0].result).estimateId).toBe("original-id-from-first-call");
  });

  it("returns HTTP 200 with a tool-level error when the database fails", async () => {
    mockPersist.mockRejectedValueOnce(new Error("connection refused"));

    const res = await postTool(validCall);

    expect(res.status).toBe(200);
    expect(res.body.results[0].toolCallId).toBe("call_123");
    expect(res.body.results[0].error).toMatch(/Could not save the estimate/);
    expect(res.body.results[0].result).toBeUndefined();
  });

  it("does not leak internal detail when the database fails", async () => {
    mockPersist.mockRejectedValueOnce(new Error("password=hunter2 at /src/db/estimates.ts:42"));

    const res = await postTool(validCall);

    expect(JSON.stringify(res.body)).not.toMatch(/hunter2|\.ts:/);
  });

  it("persists nothing for an unsupported service", async () => {
    await postTool(envelope({ arguments: { service: "engine_rebuild", vehicle } }));

    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("persists nothing for an unsupported tool name", async () => {
    await postTool(envelope({ arguments: { service: "front_brake_pads", vehicle } }, { name: "book_appointment" }));

    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("persists nothing for malformed parameters", async () => {
    await postTool(envelope({ arguments: { service: "front_brake_pads" } }));

    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("persists nothing for a malformed envelope", async () => {
    await postTool({ nonsense: true });

    expect(mockPersist).not.toHaveBeenCalled();
  });
});
