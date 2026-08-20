import { createApp } from "./app.js";
import { getConfig, isSmsEnabled, missingSmsConfig } from "./config.js";

// Check the environment before starting so a missing variable is an obvious
// message at boot rather than a confusing failure on the first request.
let config;
try {
  config = getConfig();
} catch (err) {
  console.error(`Startup failed: ${(err as Error).message}`);
  process.exit(1);
}

const app = createApp();

app.listen(config.port, () => {
  console.log(`Mechanic-shop receptionist API listening on port ${config.port}`);

  // SMS is an optional extra, never a reason to refuse to run. Estimates,
  // calls, and requests all work regardless; only the texting stops.
  // Names only, never values.
  if (!isSmsEnabled()) {
    console.log("SMS notifications are disabled.");
    return;
  }

  const missingSms = missingSmsConfig();
  if (missingSms.length > 0) {
    // Turned on but unusable. Warn loudly and carry on serving calls rather
    // than taking the receptionist down over a notification channel.
    console.warn(
      `SMS is enabled but not configured, so nothing will be texted. ` +
        `Missing: ${missingSms.join(", ")}. Requests are still recorded.`
    );
  }
});
