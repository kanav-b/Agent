import express from "express";
import { estimateRouter } from "./routes/estimate.js";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", estimateRouter);
  return app;
}
