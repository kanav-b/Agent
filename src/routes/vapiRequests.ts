import { Router } from "express";
import { appointmentRequestSchema, callbackRequestSchema } from "../schemas/requests.js";
import {
  createAppointmentRequest,
  createCallbackRequest,
  logRequestFailure
} from "../db/requests.js";
import { handleToolCalls, toolError, toolResult } from "./vapiToolCall.js";
import {
  sendCustomerAppointmentConfirmation,
  sendCustomerCallbackConfirmation,
  sendShopAppointmentNotification,
  sendShopCallbackNotification
} from "../notifications/sms.js";

/**
 * Tools the assistant uses to record what a caller asked for.
 *
 * Both create *requests*, never bookings. The wording sent back to the
 * assistant says so plainly, so it cannot tell a caller their appointment is
 * confirmed when the shop has not seen it yet.
 *
 * Once a request is stored the shop is texted, and the caller is texted too
 * if they explicitly asked for a confirmation. Delivery happens *after* the
 * request is safely stored and never undoes it: a stored request stays stored
 * even when every message fails, and the reply only claims a text was sent
 * when the provider actually accepted it.
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

        // The request is safely stored from here on. Nothing below can undo it.
        const ref = {
          businessId: parsed.data.businessId,
          vapiCallId: context.vapiCallId,
          requestId: created.requestId
        };
        const summary = {
          vehicleYear: parsed.data.vehicle?.year,
          vehicleMake: parsed.data.vehicle?.make,
          vehicleModel: parsed.data.vehicle?.model,
          service: parsed.data.service,
          problemDescription: parsed.data.problemDescription,
          preferredDate: parsed.data.preferredDate,
          preferredTimeText: parsed.data.preferredTimeText,
          customerName: parsed.data.customer?.name,
          customerPhone: parsed.data.customer?.phone
        };

        const [shopNotification, customerConfirmation] = await Promise.all([
          sendShopAppointmentNotification(ref, summary),
          sendCustomerAppointmentConfirmation(ref, summary, parsed.data.customerSmsConsent)
        ]);

        return toolResult(toolCall.id, {
          requestId: created.requestId,
          status: "pending",
          message: APPOINTMENT_MESSAGE,
          preferredDate: parsed.data.preferredDate ?? null,
          preferredTimeText: parsed.data.preferredTimeText ?? null,
          shopNotification,
          customerConfirmation
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

        // The request is safely stored from here on. Nothing below can undo it.
        const ref = {
          businessId: parsed.data.businessId,
          vapiCallId: context.vapiCallId,
          requestId: created.requestId
        };
        const summary = {
          reason: parsed.data.reason,
          preferredCallbackAt: parsed.data.preferredCallbackAt,
          customerName: parsed.data.customer?.name,
          customerPhone: parsed.data.customer?.phone
        };

        const [shopNotification, customerConfirmation] = await Promise.all([
          sendShopCallbackNotification(ref, summary),
          sendCustomerCallbackConfirmation(ref, summary, parsed.data.customerSmsConsent)
        ]);

        return toolResult(toolCall.id, {
          requestId: created.requestId,
          status: "pending",
          message: CALLBACK_MESSAGE,
          preferredCallbackAt: parsed.data.preferredCallbackAt ?? null,
          shopNotification,
          customerConfirmation
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
