/**
 * Manual database check. Run it yourself with:
 *
 *   npm run db:check
 *
 * It confirms the connection works, that the demo-shop business is there, and
 * that the estimates and calls tables are reachable. It is never run by the
 * tests or by the server.
 *
 * It prints no credentials and no personal information: call rows are reported
 * by id, outcome, and counts only — never a phone number, a name, or a line of
 * transcript.
 */
import { getConfig } from "../config.js";
import { getSupabase } from "../db/supabase.js";

async function main(): Promise<void> {
  // Show the host only, so the key is never printed.
  const { supabaseUrl } = getConfig();
  console.log(`Connecting to ${new URL(supabaseUrl).host} ...`);

  const supabase = getSupabase();

  const { data: business, error: businessError } = await supabase
    .from("businesses")
    .select("id, name")
    .eq("id", "demo-shop")
    .maybeSingle();

  if (businessError) {
    throw new Error(`Could not query businesses: ${businessError.message}`);
  }

  if (!business) {
    console.error('FAIL  business "demo-shop" is missing. Has the migration been run?');
    process.exitCode = 1;
    return;
  }

  console.log(`OK    business found: ${business.id} (${business.name})`);

  const { data: estimates, error: estimatesError } = await supabase
    .from("estimates")
    .select("id, service, low_price, high_price, source, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  if (estimatesError) {
    throw new Error(`Could not query estimates: ${estimatesError.message}`);
  }

  if (!estimates || estimates.length === 0) {
    console.log("OK    estimates table reachable, no rows yet.");
    return;
  }

  console.log(`OK    ${estimates.length} most recent estimate(s):`);
  for (const row of estimates) {
    console.log(
      `      ${row.created_at}  ${row.source.padEnd(4)}  ${row.service}  ` +
        `$${row.low_price}-$${row.high_price}  ${row.id}`
    );
  }

  await checkCalls();
  await checkRequests();
  await checkNotifications();
}

/**
 * Reports on the calls table.
 *
 * Only non-identifying columns are selected, so there is no way for a phone
 * number, a caller name, or transcript text to reach the terminal.
 */
async function checkCalls(): Promise<void> {
  const supabase = getSupabase();

  const { count, error: countError } = await supabase
    .from("calls")
    .select("id", { count: "exact", head: true });

  if (countError) {
    throw new Error(`Could not query calls: ${countError.message}`);
  }

  console.log(`OK    calls table reachable, ${count ?? 0} row(s) total.`);

  const { data: recent, error: recentError } = await supabase
    .from("calls")
    .select("vapi_call_id, outcome, requires_follow_up, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  if (recentError) {
    throw new Error(`Could not query recent calls: ${recentError.message}`);
  }

  if (!recent || recent.length === 0) {
    console.log("OK    no calls recorded yet.");
    return;
  }

  console.log(`OK    ${recent.length} most recent call(s):`);
  for (const row of recent) {
    const followUp = row.requires_follow_up ? "follow-up" : "-";
    console.log(
      `      ${row.created_at}  ${String(row.outcome ?? "unknown").padEnd(18)}  ` +
        `${followUp.padEnd(9)}  ${row.vapi_call_id}`
    );
  }
}

/**
 * Reports on appointment and callback requests.
 *
 * Only ids, statuses, the consent flag, and timestamps are selected. Phone
 * numbers, names, problem descriptions, callback reasons, and the consent
 * timestamp are never read, so they cannot reach the terminal.
 */
async function checkRequests(): Promise<void> {
  const supabase = getSupabase();

  for (const [table, label] of [
    ["appointment_requests", "appointment"],
    ["callback_requests", "callback"]
  ] as const) {
    const { count, error: countError } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true });

    if (countError) {
      throw new Error(`Could not query ${table}: ${countError.message}`);
    }

    console.log(`OK    ${label} requests reachable, ${count ?? 0} row(s) total.`);

    const { data: recent, error: recentError } = await supabase
      .from(table)
      .select("id, status, customer_sms_consent, created_at")
      .order("created_at", { ascending: false })
      .limit(5);

    if (recentError) {
      throw new Error(`Could not query recent ${table}: ${recentError.message}`);
    }

    for (const row of recent ?? []) {
      // Whether consent was given, never when or in what words.
      const consent = row.customer_sms_consent ? "sms:yes" : "sms:no ";
      console.log(
        `      ${row.created_at}  ${String(row.status).padEnd(10)}  ${consent}  ${row.id}`
      );
    }
  }
}

/**
 * Reports on the notification log.
 *
 * The table holds no message text and no phone numbers by design, so there is
 * nothing sensitive to print. Provider credentials are never read.
 */
async function checkNotifications(): Promise<void> {
  const supabase = getSupabase();

  const { count, error: countError } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true });

  if (countError) {
    throw new Error(`Could not query notifications: ${countError.message}`);
  }

  console.log(`OK    notifications table reachable, ${count ?? 0} row(s) total.`);

  const { data: recent, error: recentError } = await supabase
    .from("notifications")
    .select("id, notification_type, recipient_type, status, created_at")
    .order("created_at", { ascending: false })
    .limit(5);

  if (recentError) {
    throw new Error(`Could not query recent notifications: ${recentError.message}`);
  }

  for (const row of recent ?? []) {
    console.log(
      `      ${row.created_at}  ${String(row.notification_type).padEnd(30)}  ` +
        `${String(row.recipient_type).padEnd(9)}  ${String(row.status).padEnd(7)}  ${row.id}`
    );
  }
}

main().catch((err: unknown) => {
  console.error(`FAIL  ${(err as Error).message}`);
  process.exitCode = 1;
});
