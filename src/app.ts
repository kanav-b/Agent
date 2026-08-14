import express from "express";
import { estimateRouter } from "./routes/estimate.js";
import { healthRouter } from "./routes/health.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/", healthRouter);
  app.use("/api", estimateRouter);
  return app;
}
