import express from "express";
import { estimateRouter } from "./routes/estimate.js";
import { healthRouter } from "./routes/health.js";
import { vapiRouter } from "./routes/vapi.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/", healthRouter);
  app.use("/api", estimateRouter);
  app.use("/api/vapi/tools", vapiRouter);
  return app;
}
