import express from "express";
import { estimateRouter } from "./routes/estimate.js";
import { healthRouter } from "./routes/health.js";
import { vapiRouter } from "./routes/vapi.js";
import { vapiEventsRouter } from "./routes/vapiEvents.js";
import { vapiRequestsRouter } from "./routes/vapiRequests.js";
import { requireVapiToolSecret } from "./middleware/vapiAuth.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  // Public: used by hosting platforms to check the server is alive.
  app.use("/", healthRouter);

  app.use("/api", estimateRouter);

  // The tool secret is checked before the router, so an unauthorised request
  // never reaches pricing or the database.
  app.use("/api/vapi/tools", requireVapiToolSecret, vapiRouter);
  app.use("/api/vapi/tools", requireVapiToolSecret, vapiRequestsRouter);

  // Same secret, same middleware — one shared secret for everything Vapi sends.
  app.use("/api/vapi", requireVapiToolSecret, vapiEventsRouter);

  // These two must stay last: anything that reaches them had no route, or
  // failed on the way through.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
