import type { NextFunction, Request, Response } from "express";

/**
 * The last two middlewares in the app.
 *
 * Without them Express answers with its own HTML error page, which in
 * development includes a stack trace and absolute file paths. Everything here
 * replies with JSON and says nothing about how the server is built.
 */

/** Anything the caller could have got wrong is reported as itself; the rest as 500. */
interface HttpishError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

/** Runs when no route matched. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Not found." });
}

/**
 * Runs when a middleware or route passed an error along.
 *
 * The four-argument signature is what marks this as Express's error handler,
 * so `next` has to stay even though it is unused.
 */
export function errorHandler(
  err: HttpishError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const status = err.status ?? err.statusCode ?? 500;

  // Log enough to find the request again, but no headers (they carry the tool
  // secret) and no stack trace.
  console.error(`[http] ${req.method} ${req.path} -> ${status}: ${err.message}`);

  // express.json() could not parse the body.
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON request body." });
    return;
  }

  // express.json() rejected an oversized body.
  if (err.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large." });
    return;
  }

  // Any other client-side mistake: report the status, not the reason.
  if (status >= 400 && status < 500) {
    res.status(status).json({ error: "Bad request." });
    return;
  }

  // A bug or an unexpected failure. The caller learns nothing about it.
  res.status(500).json({ error: "Internal server error." });
}
