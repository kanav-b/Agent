import { Router } from "express";

export const healthRouter = Router();

// Used by hosting platforms (and later by Vapi) to check the server is alive.
healthRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});
