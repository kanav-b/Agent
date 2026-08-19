import { createApp } from "./app.js";
import { getConfig } from "./config.js";

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
});
