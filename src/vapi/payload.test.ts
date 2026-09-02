import { describe, expect, it } from "vitest";
import { buildBusinessAssistantConfig } from "../assistant/generate.js";
import { buildCreatePayload, buildUpdatePayload, toolIdList } from "./payload.js";

/**
 * What actually gets sent to a live receptionist.
 *
 * Pure translation, so every field can be asserted without a network call.
 */

const config = buildBusinessAssistantConfig({
  business: { id: "joes-garage", name: "Joe's Garage", timezone: "America/New_York" },
  hours: [{ dayOfWeek: 1, openTime: "08:00:00", closeTime: "17:00:00", isClosed: false }],
  services: [{ serviceKey: "front_brake_pads", displayName: "Front Brake Pads" }]
});

const tools = {
  estimateToolId: "tool_estimate_1",
  appointmentRequestToolId: "tool_appointment_1",
  callbackRequestToolId: "tool_callback_1"
};

const defaults = { modelProvider: "openai", model: "gpt-4o" };

const create = () => buildCreatePayload(config, tools, defaults);

/** A model object as an existing assistant would have it. */
const existingModel = {
  provider: "anthropic",
  model: "claude-sonnet-4",
  temperature: 0.4,
  toolIds: ["tool_estimate_1", "tool_appointment_1", "tool_callback_1"],
  messages: [{ role: "system", content: "the old prompt" }],
  knowledgeBaseId: "kb_123"
};

describe("create payload", () => {
  it("maps the assistant name", () => {
    expect(create().name).toBe("Joe's Garage Receptionist");
  });

  it("maps the first message", () => {
    expect(create().firstMessage).toBe(config.firstMessage);
    expect(create().firstMessage).toContain("Joe's Garage");
  });

  it("maps the system prompt into the model messages", () => {
    const model = create().model as Record<string, unknown>;
    const messages = model.messages as Array<Record<string, unknown>>;

    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe(config.systemPrompt);
  });

  it("keeps the businessId instruction inside the prompt it sends", () => {
    const model = create().model as Record<string, unknown>;
    const messages = model.messages as Array<{ content: string }>;

    expect(messages[0].content).toContain('businessId = "joes-garage"');
  });

  it("attaches the three shared tools by id", () => {
    const model = create().model as Record<string, unknown>;

    expect(model.toolIds).toEqual([
      "tool_estimate_1",
      "tool_appointment_1",
      "tool_callback_1"
    ]);
  });

  it("lists the tools in a stable order", () => {
    expect(toolIdList(tools)).toEqual([
      "tool_estimate_1",
      "tool_appointment_1",
      "tool_callback_1"
    ]);
  });

  it("sets the model provider only at creation", () => {
    const model = create().model as Record<string, unknown>;

    expect(model.provider).toBe("openai");
    expect(model.model).toBe("gpt-4o");
  });

  it("sends nothing this project does not own", () => {
    expect(Object.keys(create()).sort()).toEqual(["firstMessage", "model", "name"]);
  });

  it("sends no voice, transcriber, or server settings", () => {
    const serialised = JSON.stringify(create());

    for (const field of ["voice", "transcriber", "serverUrl", "server", "voicemail"]) {
      expect(serialised).not.toContain(`"${field}"`);
    }
  });

  it("assigns no phone number", () => {
    const serialised = JSON.stringify(create());

    expect(serialised).not.toMatch(/phoneNumber|phone_number|twilio/i);
  });

  it("sends no notification phone", () => {
    const serialised = JSON.stringify(create());

    expect(serialised).not.toMatch(/notification/i);
  });

  it("copies no prices into the provider payload", () => {
    const serialised = JSON.stringify(create());

    expect(serialised).not.toMatch(/lowPrice|highPrice|low_price|high_price/);
    expect(serialised).not.toMatch(/\$\d/);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(create())).toBe(JSON.stringify(create()));
  });
});

describe("update payload", () => {
  const update = () => buildUpdatePayload(config, existingModel);

  it("maps the name and first message", () => {
    expect(update().name).toBe("Joe's Garage Receptionist");
    expect(update().firstMessage).toBe(config.firstMessage);
  });

  it("replaces only the system prompt", () => {
    const model = update().model as Record<string, unknown>;
    const messages = model.messages as Array<{ content: string }>;

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(config.systemPrompt);
    expect(messages[0].content).not.toContain("the old prompt");
  });

  it("preserves the provider and model the assistant already had", () => {
    // PATCH replaces a nested object wholesale, so anything not carried
    // through here would be silently dropped from a live assistant.
    const model = update().model as Record<string, unknown>;

    expect(model.provider).toBe("anthropic");
    expect(model.model).toBe("claude-sonnet-4");
    expect(model.temperature).toBe(0.4);
  });

  it("preserves the tools already attached, rather than reattaching them", () => {
    const model = update().model as Record<string, unknown>;

    expect(model.toolIds).toEqual([
      "tool_estimate_1",
      "tool_appointment_1",
      "tool_callback_1"
    ]);
  });

  it("preserves settings it knows nothing about", () => {
    const model = update().model as Record<string, unknown>;

    expect(model.knowledgeBaseId).toBe("kb_123");
  });

  it("still sends only the three fields it owns", () => {
    expect(Object.keys(update()).sort()).toEqual(["firstMessage", "model", "name"]);
  });

  it("copes with an assistant that has no model object", () => {
    const model = buildUpdatePayload(config, undefined).model as Record<string, unknown>;
    const messages = model.messages as Array<{ content: string }>;

    expect(messages[0].content).toBe(config.systemPrompt);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(update())).toBe(JSON.stringify(update()));
  });
});
