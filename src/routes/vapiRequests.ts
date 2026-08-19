import { Router } from "express";
import { appointmentRequestSchema, callbackRequestSchema } from "../schemas/requests.js";
import {
  createAppointmentRequest,
  createCallbackRequest,
  logRequestFailure
} from "../db/requests.js";
import { handleToolCalls, toolError, toolResult } from "./vapiToolCall.js";

/**
 * Tools the assistant uses to record what a caller asked for.
 *
 * Both create *requests*, never bookings. The wording sent back to the
 * assistant says so plainly, so it cannot tell a caller their appointment is
 * confirmed when the shop has not seen it yet.
 *
 * Authentication happens in middleware before any of this runs.
 */

export const CREATE_APPOINTMENT_REQUEST = "create_appointment_request";
export const CREATE_CALLBACK_REQUEST = "create_callback_request";

/** Said back to the caller. Deliberately not "booked" or "confirmed". */
const APPOINTMENT_MESSAGE =
  "Appointment request recorded. The shop still needs to confirm it, so it is not booked yet.";
const CALLBACK_MESSAGE =
  "Callback request recorded. It is pending until someone from the shop follows up.";

export const vapiRequestsRouter = Router();

vapiRequestsRouter.post("/appointment-request", async (req, res) => {
  const response = await handleToolCalls(
    req.body,
    CREATE_APPOINTMENT_REQUEST,
    async (toolCall, context) => {
      const parsed = appointmentRequestSchema.safeParse(toolCall.arguments);

      if (!parsed.success) {
        return toolError(
          toolCall.id,
          "Could not record the appointment request. It needs a service or a description of " +
            "the problem, and a preferred date (YYYY-MM-DD) or a preferred time."
        );
      }

      try {
        const created = await createAppointmentRequest(parsed.data, {
          vapiToolCallId: toolCall.id,
          vapiCallId: context.vapiCallId
        });

        return toolResult(toolCall.id, {
          requestId: created.requestId,
          status: "pending",
          message: APPOINTMENT_MESSAGE,
          preferredDate: parsed.data.preferredDate ?? null,
          preferredTimeText: parsed.data.preferredTimeText ?? null
        });
      } catch (err) {
        logRequestFailure(err, {
          kind: "appointment",
          toolCallId: toolCall.id,
          vapiCallId: context.vapiCallId,
          businessId: parsed.data.businessId
        });

        // Never let the assistant claim a request that was not stored.
        return toolError(
          toolCall.id,
          "Could not record the appointment request right now. Please try again in a moment."
        );
      }
    }
  );

  return res.status(response.status).json(response.body);
});

vapiRequestsRouter.post("/callback-request", async (req, res) => {
  const response = await handleToolCalls(
    req.body,
    CREATE_CALLBACK_REQUEST,
    async (toolCall, context) => {
      const parsed = callbackRequestSchema.safeParse(toolCall.arguments);

      if (!parsed.success) {
        return toolError(
          toolCall.id,
          "Could not record the callback request. If a preferred time is given it must be an " +
            "ISO datetime including a timezone, for example 2026-08-20T14:00:00Z."
        );
      }

      try {
        const created = await createCallbackRequest(parsed.data, {
          vapiToolCallId: toolCall.id,
          vapiCallId: context.vapiCallId
        });

        return toolResult(toolCall.id, {
          requestId: created.requestId,
          status: "pending",
          message: CALLBACK_MESSAGE,
          preferredCallbackAt: parsed.data.preferredCallbackAt ?? null
        });
      } catch (err) {
        logRequestFailure(err, {
          kind: "callback",
          toolCallId: toolCall.id,
          vapiCallId: context.vapiCallId,
          businessId: parsed.data.businessId
        });

        return toolError(
          toolCall.id,
          "Could not record the callback request right now. Please try again in a moment."
        );
      }
    }
  );

  return res.status(response.status).json(response.body);
});
