// Frontend mirror of the Rust wire types.
//
// These mirror `src-tauri/src/domain/model.rs`, `app_state.rs`,
// `brands/directory.rs`, and `poller.rs`. They describe what crosses the Tauri
// IPC boundary; the Rust core is the source of truth.

export type FuelCode = "Gazole" | "SP95" | "E10" | "SP98" | "E85" | "GPLc";

export const FUEL_CODES: readonly FuelCode[] = ["Gazole", "SP95", "E10", "SP98", "E85", "GPLc"];

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
  readonly fuels: Readonly<Record<string, FuelState>>;
}

export interface BrandDirectory {
  readonly updatedAt: string;
  readonly brands: Readonly<Record<string, readonly number[]>>;
}

export const EMPTY_BRAND_DIRECTORY: BrandDirectory = {
  updatedAt: new Date(0).toISOString(),
  brands: {},
};

export type SortMode = "distance" | "price";

export interface AppFilters {
  readonly longitude: number;
  readonly latitude: number;
  readonly radiusKm: number;
  readonly freeText: string;
  readonly selectedBrands: readonly string[];
  readonly selectedFuel: FuelCode | null;
  readonly onlyAvailable: boolean;
  readonly sortBy: SortMode;
  readonly notificationsEnabled: boolean;
}

export interface AppState {
  readonly version: 1;
  readonly filters: AppFilters;
  readonly brandDirectory: BrandDirectory;
  readonly brandArea: string | null;
  readonly trackers: Record<string, unknown>;
  readonly updatedAt: string;
}

export interface PollSnapshot {
  readonly stations: StationSnapshot[];
  readonly fetchedAt: string;
  readonly dataUpdatedAt: string | null;
  readonly polling: boolean;
  readonly error: string | null;
  readonly pollIntervalMs: number;
}
