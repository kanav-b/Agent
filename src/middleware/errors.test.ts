import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../db/estimates.js", () => ({
  persistEstimate: vi.fn(async (input: { estimateId: string }) => ({
    estimateId: input.estimateId,
    reused: false
  }))
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
import { errorHandler, notFoundHandler } from "./errors.js";
import { VAPI_SECRET_HEADER } from "./vapiAuth.js";

const TEST_SECRET = "test-vapi-secret-not-real";
process.env.SUPABASE_URL = "https://test.invalid";
process.env.SUPABASE_SECRET_KEY = "test-supabase-key-not-real";
process.env.VAPI_TOOL_SECRET = TEST_SECRET;

const app = createApp();

/** Things that must never appear in a response body. */
function expectNoInternals(body: string): void {
  expect(body).not.toMatch(/<html|<!DOCTYPE/i); // no HTML error page
  expect(body).not.toMatch(/\/Users\/|\/home\/|node_modules/); // no filesystem paths
  expect(body).not.toMatch(/\bat [A-Za-z._]+ \(/); // no stack frames
  expect(body).not.toMatch(/SyntaxError|TypeError|\.ts:\d+|\.js:\d+/); // no exception detail
}

describe("malformed JSON", () => {
  it("returns a JSON 400 from /api/estimate", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .set("Content-Type", "application/json")
      .send("{bad json");

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "Invalid JSON request body." });
  });

  it("leaks no stack trace, path, or HTML from /api/estimate", async () => {
    const res = await request(app)
      .post("/api/estimate")
      .set("Content-Type", "application/json")
      .send("{bad json");

    expectNoInternals(res.text);
  });

  it("returns a safe JSON response from the Vapi endpoint", async () => {
    const res = await request(app)
      .post("/api/vapi/tools/estimate")
      .set(VAPI_SECRET_HEADER, TEST_SECRET)
      .set("Content-Type", "application/json")
      .send("{bad json");

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "Invalid JSON request body." });
    expectNoInternals(res.text);
  });

  it("does not invent a toolCallId when the body cannot be parsed", async () => {
    const res = await request(app)
      .post("/api/vapi/tools/estimate")
      .set(VAPI_SECRET_HEADER, TEST_SECRET)
      .set("Content-Type", "application/json")
      .send("{bad json");

    expect(res.body.results).toBeUndefined();
    expect(res.text).not.toContain("toolCallId");
  });
});

describe("unknown routes", () => {
  it("returns a JSON 404", async () => {
    const res = await request(app).get("/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "Not found." });
  });

  it("returns a JSON 404 for a wrong method on a real path", async () => {
    const res = await request(app).get("/api/estimate");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found." });
    expectNoInternals(res.text);
  });
});

describe("unexpected server errors", () => {
  // A throwaway app whose only route throws, so the real routes keep their
  // behaviour while the 500 path is still exercised for real.
  function appThatThrows() {
    const throwing = express();
    throwing.get("/boom", () => {
      throw new Error("secret internal detail at /Users/someone/app/src/thing.ts:42");
    });
    throwing.use(notFoundHandler);
    throwing.use(errorHandler);
    return throwing;
  }

  it("returns a JSON 500 without the underlying exception", async () => {
    const res = await request(appThatThrows()).get("/boom");

    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "Internal server error." });
  });

  it("leaks no internals on a 500", async () => {
    const res = await request(appThatThrows()).get("/boom");

    expect(res.text).not.toContain("secret internal detail");
    expectNoInternals(res.text);
  });
});
