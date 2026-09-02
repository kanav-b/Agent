import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The layering this phase depends on, asserted against the source.
 *
 * These check *dependencies* rather than wording, so they fail when a layer
 * reaches somewhere it should not, and stay quiet when prose is reworded.
 */

const root = new URL("../", import.meta.url).pathname;

const read = (path: string) => readFileSync(`${root}${path}`, "utf8");

/** Only the module's own import statements, not its prose. */
const importsOf = (source: string) => source.match(/^\s*import[\s\S]*?from\s+"[^"]+";/gm) ?? [];

describe("the generated config knows nothing about a provider", () => {
  const source = read("assistant/generate.ts");

  it("imports nothing at all", () => {
    expect(importsOf(source)).toEqual([]);
  });

  it("reaches no provider and no network", () => {
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/api\.vapi\.ai/);
  });
});

describe("the loader stays out of provider code", () => {
  const source = read("assistant/load.ts");

  it("imports no Vapi module", () => {
    expect(importsOf(source).join("\n")).not.toMatch(/\/vapi\//);
  });

  it("makes no HTTP call of its own", () => {
    expect(source).not.toMatch(/\bfetch\(/);
  });
});

describe("the provider modules stay out of the database", () => {
  for (const file of ["vapi/client.ts", "vapi/payload.ts"]) {
    it(`${file} never queries Supabase`, () => {
      const source = read(file);

      expect(importsOf(source).join("\n")).not.toMatch(/db\/|supabase/);
      expect(source).not.toMatch(/getSupabase|\.from\(/);
    });
  }

  it("payload translation makes no HTTP call", () => {
    const source = read("vapi/payload.ts");

    expect(source).not.toMatch(/\bfetch\(/);
    expect(importsOf(source).join("\n")).not.toMatch(/client\.js/);
  });
});

describe("the integration table module stays out of the provider", () => {
  const source = read("db/integrations.ts");

  it("calls no provider API", () => {
    expect(importsOf(source).join("\n")).not.toMatch(/\/vapi\//);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/api\.vapi\.ai/);
  });
});

describe("credentials are never written into the source", () => {
  const files = [
    "config.ts",
    "vapi/client.ts",
    "vapi/payload.ts",
    "vapi/sync.ts",
    "scripts/assistant-sync.ts"
  ];

  it("reads the API key from the environment and nowhere else", () => {
    for (const file of files) {
      const source = read(file);

      // A literal assignment such as VAPI_API_KEY = "sk-..." would match.
      expect(source).not.toMatch(/VAPI_API_KEY\s*=\s*["'][^"']+["']/);
    }
  });

  it("never prints the key", () => {
    for (const file of files) {
      const source = read(file);
      const logged = source.match(/console\.\w+\([\s\S]*?\);/g) ?? [];

      expect(logged.join("\n")).not.toMatch(/apiKey|VAPI_API_KEY|Authorization|Bearer/);
    }
  });

  it("sends the key only as an Authorization header from the client", () => {
    const client = read("vapi/client.ts");
    const others = ["vapi/payload.ts", "vapi/sync.ts", "scripts/assistant-sync.ts"];

    expect(client).toMatch(/Authorization/);

    for (const file of others) {
      expect(read(file)).not.toMatch(/Authorization/);
    }
  });
});
