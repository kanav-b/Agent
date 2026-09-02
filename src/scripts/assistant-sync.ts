/**
 * Synchronises a shop's generated configuration to its Vapi assistant.
 *
 *   npm run assistant:sync -- demo-shop            plan only, no remote write
 *   npm run assistant:sync -- demo-shop --apply    perform the write
 *
 * Without --apply this reads the database, works out whether a sync would
 * create or update, and stops. It contacts Vapi only with --apply, and it
 * never deletes anything.
 *
 * Prints no API key, no authorization header, no prompt text, and no payload.
 * Use `npm run assistant:preview` to read a generated prompt.
 */
import { missingVapiConfig } from "../config.js";
import { applySync, planSync, SyncError } from "../vapi/sync.js";

function usage(): void {
  console.error("Usage: npm run assistant:sync -- <businessId> [--apply]");
  console.error("Example: npm run assistant:sync -- demo-shop");
  console.error("         npm run assistant:sync -- demo-shop --apply");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const businessId = args.find((arg) => !arg.startsWith("--"));

  if (!businessId) {
    usage();
    process.exitCode = 1;
    return;
  }

  const plan = await planSync(businessId);

  console.log(`Business:      ${plan.businessName}`);
  console.log(`Business ID:   ${plan.businessId}`);
  console.log(`Operation:     ${plan.operation.toUpperCase()}`);
  console.log(`Assistant:     ${plan.assistantName}`);
  console.log(`Services:      ${plan.serviceCount}`);
  console.log(`Timezone:      ${plan.timezone}`);

  if (plan.assistantId) {
    console.log(`Vapi assistant: ${plan.assistantId}`);
  }

  if (!apply) {
    // The safe default. Say what is missing now rather than at --apply time.
    const missing = missingVapiConfig();

    console.log("Remote changes: NO (--apply not supplied)");

    if (missing.length > 0) {
      console.log(`Note:          ${missing.join(", ")} not set; --apply would fail.`);
    }
    return;
  }

  const result = await applySync(plan);

  console.log(`Result:        synchronized`);
  console.log(`Vapi assistant: ${result.assistantId}`);
}

main().catch((err: unknown) => {
  // SyncError messages are written for an operator and carry no provider body,
  // no key, and no prompt text. Anything else is reported generically.
  if (err instanceof SyncError) {
    console.error(`FAIL  ${err.message}`);
  } else {
    console.error(`FAIL  ${(err as Error)?.message ?? "The sync could not be completed."}`);
  }
  process.exitCode = 1;
});
