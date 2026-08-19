import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { getConfig } from "../config.js";

/** The header Vapi must send on every custom-tool request. */
export const VAPI_SECRET_HEADER = "x-vapi-tool-secret";

/**
 * Compares two secrets without leaking how much of the guess was right.
 *
 * timingSafeEqual needs equal-length buffers and would otherwise reveal the
 * secret's length, so both sides are hashed first: the digests are always 32
 * bytes, and the comparison time does not depend on where they differ.
 */
function secretsMatch(supplied: string, expected: string): boolean {
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expected).digest();

  return timingSafeEqual(suppliedHash, expectedHash);
}

/**
 * Rejects Vapi tool requests that do not carry the shared secret.
 *
 * Mounted in front of the Vapi router, so an unauthorised request never
 * reaches pricing or the database. The reply is the same whether the header
 * was missing or wrong, and the secret itself is never logged.
 */
export function requireVapiToolSecret(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.get(VAPI_SECRET_HEADER);

  if (!supplied || !secretsMatch(supplied, getConfig().vapiToolSecret)) {
    // No detail about which part failed, and nothing about the value sent.
    console.warn(`[auth] rejected ${req.method} ${req.originalUrl}: bad or missing tool secret`);
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  next();
}
