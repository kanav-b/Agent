/**
 * Prints the assistant configuration this backend would generate for a shop.
 *
 *   npm run assistant:preview -- demo-shop
 *
 * Read-only and developer-only. It writes nothing, and it publishes nothing to
 * Vapi — that is a later phase. It prints no credentials, no notification
 * number, and no customer data, because the generated config contains none of
 * those in the first place.
 */
import { loadBusinessAssistantConfig } from "../assistant/load.js";

async function main(): Promise<void> {
  const businessId = process.argv[2];

  if (!businessId) {
    console.error("Usage: npm run assistant:preview -- <businessId>");
    console.error("Example: npm run assistant:preview -- demo-shop");
    process.exitCode = 1;
    return;
  }

  const result = await loadBusinessAssistantConfig(businessId);

  if (!result.ok) {
    const reason =
      result.problem === "not_found"
        ? "no such business"
        : "the business is marked inactive";
    console.error(`FAIL  Cannot generate a config for "${businessId}": ${reason}.`);
    process.exitCode = 1;
    return;
  }

  const { config } = result;

  console.log(`Business:  ${config.businessId}`);
  console.log(`Assistant: ${config.assistantName}`);
  console.log(`Services:  ${config.supportedServices.length}`);
  console.log(`Timezone:  ${config.timezone}`);
  console.log("");
  console.log("--- firstMessage ---");
  console.log(config.firstMessage);
  console.log("");
  console.log("--- systemPrompt ---");
  console.log(config.systemPrompt);
}

main().catch((err: unknown) => {
  console.error(`FAIL  ${(err as Error).message}`);
  process.exitCode = 1;
});
