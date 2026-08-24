import { getSupabase } from "./supabase.js";

/**
 * Queries for a shop's own configuration: who it is, when it is open, and
 * what it charges.
 *
 * These are plain reads. Nothing here decides anything — callers combine the
 * rows into the shapes they need.
 */

export class BusinessConfigError extends Error {
  readonly step: string;
  readonly code?: string;

  constructor(step: string, message: string, code?: string) {
    super(message);
    this.name = "BusinessConfigError";
    this.step = step;
    this.code = code;
  }
}

function fail(step: string, error: { message: string; code?: string }): never {
  throw new BusinessConfigError(step, error.message, error.code);
}

export interface BusinessRow {
  id: string;
  name: string;
  phone: string | null;
  notificationPhone: string | null;
  timezone: string;
  afterHoursMessage: string | null;
  isActive: boolean;
}

export interface BusinessHoursRow {
  dayOfWeek: number;
  openTime: string | null;
  closeTime: string | null;
  isClosed: boolean;
}

export interface BusinessServiceRow {
  serviceKey: string;
  displayName: string;
  lowPrice: number;
  highPrice: number;
  currency: string;
  disclaimer: string;
  isActive: boolean;
}

const BUSINESS_COLUMNS =
  "id, name, phone, notification_phone, timezone, after_hours_message, is_active";

function toBusiness(row: Record<string, unknown>): BusinessRow {
  return {
    id: row.id as string,
    name: row.name as string,
    phone: (row.phone as string | null) ?? null,
    notificationPhone: (row.notification_phone as string | null) ?? null,
    timezone: (row.timezone as string | null) ?? "UTC",
    afterHoursMessage: (row.after_hours_message as string | null) ?? null,
    isActive: row.is_active !== false
  };
}

/** The shop's row, or null when there is no such shop. */
export async function getBusiness(businessId: string): Promise<BusinessRow | null> {
  const { data, error } = await getSupabase()
    .from("businesses")
    .select(BUSINESS_COLUMNS)
    .eq("id", businessId)
    .maybeSingle();

  if (error) fail("getBusiness", error);

  return data ? toBusiness(data as Record<string, unknown>) : null;
}

/** Opening hours, one row per day the shop has configured. */
export async function getBusinessHours(businessId: string): Promise<BusinessHoursRow[]> {
  const { data, error } = await getSupabase()
    .from("business_hours")
    .select("day_of_week, open_time, close_time, is_closed")
    .eq("business_id", businessId)
    .order("day_of_week", { ascending: true });

  if (error) fail("getBusinessHours", error);

  return (data ?? []).map((row: Record<string, unknown>) => ({
    dayOfWeek: row.day_of_week as number,
    openTime: (row.open_time as string | null) ?? null,
    closeTime: (row.close_time as string | null) ?? null,
    isClosed: row.is_closed === true
  }));
}

const SERVICE_COLUMNS =
  "service_key, display_name, low_price, high_price, currency, disclaimer, is_active";

function toService(row: Record<string, unknown>): BusinessServiceRow {
  return {
    serviceKey: row.service_key as string,
    displayName: row.display_name as string,
    lowPrice: row.low_price as number,
    highPrice: row.high_price as number,
    currency: (row.currency as string | null) ?? "USD",
    disclaimer: row.disclaimer as string,
    isActive: row.is_active !== false
  };
}

/**
 * One service as this shop has configured it.
 *
 * Returns the row whether or not it is active, so the caller can tell an
 * unknown service from one the shop has switched off.
 */
export async function getBusinessService(
  businessId: string,
  serviceKey: string
): Promise<BusinessServiceRow | null> {
  const { data, error } = await getSupabase()
    .from("business_services")
    .select(SERVICE_COLUMNS)
    .eq("business_id", businessId)
    .eq("service_key", serviceKey)
    .maybeSingle();

  if (error) fail("getBusinessService", error);

  return data ? toService(data as Record<string, unknown>) : null;
}

/** Everything this shop currently offers. */
export async function getActiveBusinessServices(
  businessId: string
): Promise<BusinessServiceRow[]> {
  const { data, error } = await getSupabase()
    .from("business_services")
    .select(SERVICE_COLUMNS)
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("service_key", { ascending: true });

  if (error) fail("getActiveBusinessServices", error);

  return (data ?? []).map((row) => toService(row as Record<string, unknown>));
}
