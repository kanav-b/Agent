export interface PriceRange {
  low: number;
  high: number;
}

export const SERVICE_CATALOG = {
  synthetic_oil_change: { low: 80, high: 120 },
  front_brake_pads: { low: 300, high: 450 },
  battery_replacement: { low: 190, high: 340 },
  diagnostic: { low: 149, high: 149 },
  tire_rotation: { low: 40, high: 60 }
} as const satisfies Record<string, PriceRange>;

export type ServiceName = keyof typeof SERVICE_CATALOG;

export const SUPPORTED_SERVICES = Object.keys(SERVICE_CATALOG) as ServiceName[];

export function isSupportedService(service: string): service is ServiceName {
  return service in SERVICE_CATALOG;
}
