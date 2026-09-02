import type { BusinessAssistantConfig } from "../assistant/generate.js";

/**
 * Turns a generated business assistant config into a Vapi payload.
 *
 * Pure: no HTTP, no database, no environment. Everything it needs is passed
 * in, so what gets sent to a live receptionist can be asserted in a test.
 *
 * ## What this project owns
 *
 * Only three things: the assistant's name, its first message, and its system
 * prompt. Everything else about an assistant — voice, transcriber, model
 * tuning, phone numbers, server URLs, dashboard settings — belongs to Vapi
 * and is never sent.
 *
 * ## Why an update reads before it writes
 *
 * PATCH replaces a nested object wholesale rather than merging into it. The
 * system prompt lives at `model.messages`, so sending `model: { messages }`
 * alone would silently drop the assistant's provider, model, and attached
 * tools. An update therefore takes the model the assistant already has and
 * replaces only its messages. That is targeted preservation, not mirroring
 * the whole assistant back.
 */

export interface VapiToolIds {
  estimateToolId: string;
  appointmentRequestToolId: string;
  callbackRequestToolId: string;
}

export interface VapiModelDefaults {
  modelProvider: string;
  model: string;
}

/** The system prompt, in the shape a model message takes. */
function systemMessages(config: BusinessAssistantConfig): Array<Record<string, unknown>> {
  return [{ role: "system", content: config.systemPrompt }];
}

/**
 * The tools every assistant shares.
 *
 * All shops call the same three backend endpoints; the generated prompt
 * carries the businessId that tells them apart. Nothing here creates or edits
 * a tool — these are ids of tools that already exist.
 */
export function toolIdList(tools: VapiToolIds): string[] {
  return [
    tools.estimateToolId,
    tools.appointmentRequestToolId,
    tools.callbackRequestToolId
  ];
}

/** The payload for a brand new assistant. */
export function buildCreatePayload(
  config: BusinessAssistantConfig,
  tools: VapiToolIds,
  defaults: VapiModelDefaults
): Record<string, unknown> {
  return {
    name: config.assistantName,
    firstMessage: config.firstMessage,
    model: {
      // Only used at creation. An update never changes these.
      provider: defaults.modelProvider,
      model: defaults.model,
      messages: systemMessages(config),
      toolIds: toolIdList(tools)
    }
  };
}

/**
 * The payload for an assistant that already exists.
 *
 * `existingModel` is the model object read back from the assistant moments
 * earlier. Its provider, model, tool ids, and any tuning are carried through
 * untouched; only the messages are ours to replace.
 */
export function buildUpdatePayload(
  config: BusinessAssistantConfig,
  existingModel: Record<string, unknown> | undefined
): Record<string, unknown> {
  return {
    name: config.assistantName,
    firstMessage: config.firstMessage,
    model: {
      ...(existingModel ?? {}),
      messages: systemMessages(config)
    }
  };
}
