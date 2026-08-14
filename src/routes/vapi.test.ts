import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";

const app = createApp();

const ROUTE = "/api/vapi/tools/estimate";

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
    const res = await request(app).post(ROUTE).send(validCall);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results).toHaveLength(1);
  });

  it("echoes back the same toolCallId", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(envelope({ arguments: { service: "front_brake_pads", vehicle } }, { id: "call_abc_789" }));

    expect(res.body.results[0].toolCallId).toBe("call_abc_789");
  });

  it("returns result as a single-line string", async () => {
    const res = await request(app).post(ROUTE).send(validCall);
    const { result } = res.body.results[0];

    expect(typeof result).toBe("string");
    expect(result).not.toContain("\n");
  });

  it("returns a result string that parses as JSON", async () => {
    const res = await request(app).post(ROUTE).send(validCall);

    expect(() => JSON.parse(res.body.results[0].result)).not.toThrow();
  });

  it("includes an estimateId in the parsed result", async () => {
    const res = await request(app).post(ROUTE).send(validCall);
    const parsed = JSON.parse(res.body.results[0].result);

    expect(parsed.estimateId).toBeTypeOf("string");
    expect(parsed.estimateId.length).toBeGreaterThan(0);
  });

  it("returns low 300 and high 450 for front_brake_pads", async () => {
    const res = await request(app).post(ROUTE).send(validCall);
    const parsed = JSON.parse(res.body.results[0].result);

    expect(parsed.low).toBe(300);
    expect(parsed.high).toBe(450);
  });

  it("includes the expected disclaimer", async () => {
    const res = await request(app).post(ROUTE).send(validCall);
    const parsed = JSON.parse(res.body.results[0].result);

    expect(parsed.disclaimer).toBe("Final pricing is subject to vehicle inspection.");
  });

  it("matches the prices returned by POST /api/estimate", async () => {
    const viaVapi = await request(app).post(ROUTE).send(validCall);
    const viaRest = await request(app)
      .post("/api/estimate")
      .send({ service: "front_brake_pads", vehicle });

    const parsed = JSON.parse(viaVapi.body.results[0].result);
    expect(parsed.low).toBe(viaRest.body.low);
    expect(parsed.high).toBe(viaRest.body.high);
  });

  it("also accepts arguments sent as `parameters`", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(envelope({ parameters: { service: "front_brake_pads", vehicle } }));

    const parsed = JSON.parse(res.body.results[0].result);
    expect(parsed.low).toBe(300);
  });

  it("works without businessId", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(envelope({ arguments: { service: "front_brake_pads", vehicle } }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].result).toBeTypeOf("string");
  });

  it("returns 200 with a tool-level error for an unsupported service", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(envelope({ arguments: { service: "engine_rebuild", vehicle } }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].toolCallId).toBe("call_123");
    expect(res.body.results[0].error).toMatch(/not supported/);
    expect(res.body.results[0].result).toBeUndefined();
  });

  it("returns 200 with a tool-level error for malformed parameters", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(envelope({ arguments: { service: "front_brake_pads" } }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].toolCallId).toBe("call_123");
    expect(res.body.results[0].error).toMatch(/Invalid estimate parameters/);
  });

  it("returns 200 with a tool-level error for an unsupported tool name", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(
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
    const res = await request(app)
      .post(ROUTE)
      .send(envelope({ arguments: { service: "engine_rebuild", vehicle } }));

    const { error } = res.body.results[0];
    expect(error).not.toMatch(/at \/|\.ts:|Error:/);
  });

  it("rejects a malformed envelope with no usable toolCallId", async () => {
    const res = await request(app).post(ROUTE).send({ nonsense: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid Vapi tool-call request body.");
  });

  it("rejects an envelope with the wrong message type", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send({ message: { type: "status-update", toolCallList: [] } });

    expect(res.status).toBe(400);
  });

  it("rejects an envelope with an empty toolCallList", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send({ message: { type: "tool-calls", toolCallList: [] } });

    expect(res.status).toBe(400);
  });

  it("rejects a tool call with no name in either position", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send({
        message: {
          type: "tool-calls",
          toolCallList: [{ id: "call_123", arguments: { service: "front_brake_pads", vehicle } }]
        }
      });

    expect(res.status).toBe(400);
  });

  it("ignores extra Vapi fields such as toolWithToolCallList", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send({
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
    const res = await request(app)
      .post(ROUTE)
      .send(
        nestedEnvelope({
          name: "calculate_estimate",
          arguments: { service: "front_brake_pads", vehicle }
        })
      );

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toBeUndefined();
  });

  it("reads an object from function.arguments", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(
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
    const res = await request(app)
      .post(ROUTE)
      .send(
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
    const res = await request(app)
      .post(ROUTE)
      .send(
        nestedEnvelope(
          { name: "calculate_estimate", arguments: { service: "front_brake_pads", vehicle } },
          "call_nested_456"
        )
      );

    expect(res.body.results[0].toolCallId).toBe("call_nested_456");
  });

  it("returns a tool-level error for an unsupported nested tool name", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(nestedEnvelope({ name: "book_appointment", arguments: { service: "front_brake_pads", vehicle } }));

    expect(res.status).toBe(200);
    expect(res.body.results[0].toolCallId).toBe("call_123");
    expect(res.body.results[0].error).toMatch(/Unsupported tool/);
  });

  it("returns a tool-level error for an unsupported nested service", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(
        nestedEnvelope({ name: "calculate_estimate", arguments: { service: "engine_rebuild", vehicle } })
      );

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toMatch(/not supported/);
  });

  it("returns a tool-level error for unparseable JSON-string arguments", async () => {
    const res = await request(app)
      .post(ROUTE)
      .send(nestedEnvelope({ name: "calculate_estimate", arguments: "{not valid json" }));

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

    const res = await request(app)
      .post(ROUTE)
      .send({ message: { type: "tool-calls", toolCalls: [toolCall], toolCallList: [toolCall] } });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0].toolCallId).toBe("call_example");
    expect(res.body.results[0].error).toBeUndefined();

    const parsed = JSON.parse(res.body.results[0].result);
    expect(parsed.low).toBe(300);
    expect(parsed.high).toBe(450);
  });

  it("gives the same prices as the flat shape", async () => {
    const nested = await request(app)
      .post(ROUTE)
      .send(
        nestedEnvelope({ name: "calculate_estimate", arguments: { service: "front_brake_pads", vehicle } })
      );
    const flat = await request(app).post(ROUTE).send(validCall);

    const fromNested = JSON.parse(nested.body.results[0].result);
    const fromFlat = JSON.parse(flat.body.results[0].result);

    expect(fromNested.low).toBe(fromFlat.low);
    expect(fromNested.high).toBe(fromFlat.high);
  });
});
