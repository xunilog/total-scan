export type FuelCode = "Gazole" | "SP95" | "E10" | "SP98" | "E85" | "GPLc";

export const FUEL_CODES: readonly FuelCode[] = [
  "Gazole",
  "SP95",
  "E10",
  "SP98",
  "E85",
  "GPLc",
];

export type Availability = "available" | "rupture" | "not_offered";

export interface FuelState {
  readonly status: Availability;
  readonly price: number | null;
  readonly updatedAt: string | null;
  readonly ruptureType: string | null;
  readonly ruptureStart: string | null;
}

export interface StationSnapshot {
  readonly stationId: number;
  readonly name: string;
  readonly address: string;
  readonly city: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly distanceKm: number;
  readonly fuels: ReadonlyMap<FuelCode, FuelState>;
}

export interface Alert {
  readonly stationId: number;
  readonly stationName: string;
  readonly city: string;
  readonly distanceKm: number;
  readonly fuel: FuelCode;
  readonly price: number;
  readonly updatedAt: string | null;
  readonly detectedAt: string;
}

export interface FuelTrackerState {
  readonly status: Availability;
  readonly candidate: Availability;
  readonly confirmations: number;
  readonly price: number | null;
  readonly updatedAt: string | null;
  readonly ruptureType: string | null;
  readonly ruptureStart: string | null;
  readonly lastNotifiedAt: string | null;
}

export function trackerKey(stationId: number, fuel: FuelCode): string {
  return `${stationId}:${fuel}`;
}

export function initialTrackerState(): FuelTrackerState {
  return {
    status: "not_offered",
    candidate: "not_offered",
    confirmations: 0,
    price: null,
    updatedAt: null,
    ruptureType: null,
    ruptureStart: null,
    lastNotifiedAt: null,
  };
}
