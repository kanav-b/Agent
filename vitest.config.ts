import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only run the TypeScript tests in src/. Without this, Vitest would also
    // pick up the compiled copies in dist/ after `npm run build`, which would
    // run every test twice against possibly-stale output.
    include: ["src/**/*.test.ts"]
  }
});
