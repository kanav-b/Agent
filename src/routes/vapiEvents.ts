import { Router } from "express";
import { vapiEventSchema, endOfCallReportSchema, END_OF_CALL_REPORT } from "../schemas/vapiEvents.js";
import { classifyOutcome, normalizeEndOfCall } from "../calls/normalize.js";
import { findEstimatesForCall, logCallFailure, persistCall } from "../db/calls.js";
import { hasRequestForCall, linkRequestsToCustomer } from "../db/requests.js";

export const vapiEventsRouter = Router();

/**
 * Receives Vapi server events.
 *
 * Only the end-of-call report is acted on. Every other event type is
 * acknowledged and dropped, so Vapi can point all of its events here without
 * this endpoint needing to grow a handler per type.
 *
 * Authentication happens in middleware before this runs.
 */
vapiEventsRouter.post("/events", async (req, res) => {
  const parsed = vapiEventSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid Vapi event body." });
  }

  const { message } = parsed.data;

  if (message.type !== END_OF_CALL_REPORT) {
    return res.status(200).json({ status: "ignored" });
  }

  // An end-of-call report without a call id cannot be stored against anything.
  const report = endOfCallReportSchema.safeParse(parsed.data);

  if (!report.success) {
    return res.status(400).json({ error: "End-of-call report is missing a call id." });
  }

  const data = normalizeEndOfCall(message);

  try {
    // Rows written during the call are the hard evidence about what it
    // achieved, so they are read before deciding the outcome.
    const [estimates, callbackRequested, appointmentRequested] = await Promise.all([
      findEstimatesForCall(data.vapiCallId),
      hasRequestForCall("callback", data.vapiCallId),
      hasRequestForCall("appointment", data.vapiCallId)
    ]);

    const verdict = classifyOutcome(data, {
      estimateProvided: estimates.length > 0,
      callbackRequested,
      appointmentRequested
    });

    const { customerId } = await persistCall({ ...data, ...verdict });

    if (customerId) {
      // Requests made during the call did not know who was speaking either.
      await linkRequestsToCustomer(data.vapiCallId, customerId);
    }

    return res.status(200).json({ status: "ok" });
  } catch (err) {
    // Log the step and code only — never the phone number, name, or words.
    logCallFailure(err, { vapiCallId: data.vapiCallId, businessId: data.businessId });

    // 500 so Vapi knows the report was not recorded and can send it again.
    // Retries are safe: vapi_call_id is unique and the write is an upsert.
    return res.status(500).json({ error: "Could not save the call. Please retry." });
  }
});
