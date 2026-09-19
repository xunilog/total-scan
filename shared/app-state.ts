// Shared application state for the desktop app.
//
// The Deno/tray process owns this state and persists it to disk so polling can
// continue with the window closed. The webview is a view over the same state,
// reading and writing it through `/api/state` (see `server.ts`). The headless
// `watcher/` remains independent; this is the desktop app's own state.

import {
  type BrandDirectory,
  EMPTY_BRAND_DIRECTORY,
} from "../watcher/brands/directory.ts";
import {
  FUEL_CODES,
  type FuelCode,
  type FuelState,
  type FuelTrackerState,
  type StationSnapshot,
} from "../watcher/domain/model.ts";

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

export const DEFAULT_FILTERS: AppFilters = {
  longitude: 7.687329,
  latitude: 48.579682,
  radiusKm: 10,
  freeText: "",
  selectedBrands: [],
  selectedFuel: null,
  onlyAvailable: false,
  sortBy: "distance",
  notificationsEnabled: false,
};

export interface AppState {
  readonly version: 1;
  readonly filters: AppFilters;
  readonly brandDirectory: BrandDirectory;
  readonly brandArea: string | null;
  readonly trackers: Record<string, FuelTrackerState>;
  readonly updatedAt: string;
}

export function createInitialState(): AppState {
  return {
    version: 1,
    filters: DEFAULT_FILTERS,
    brandDirectory: EMPTY_BRAND_DIRECTORY,
    brandArea: null,
    trackers: {},
    updatedAt: new Date(0).toISOString(),
  };
}

function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function toFuelCode(value: unknown): FuelCode | null {
  if (typeof value !== "string") return null;
  return (FUEL_CODES as readonly string[]).includes(value)
    ? (value as FuelCode)
    : null;
}

export function normalizeFilters(input: unknown): AppFilters {
  const raw = (input ?? {}) as Partial<Record<keyof AppFilters, unknown>>;
  const brands = Array.isArray(raw.selectedBrands)
    ? raw.selectedBrands.filter((brand): brand is string =>
      typeof brand === "string"
    )
    : [];
  const sortBy = raw.sortBy === "price" || raw.sortBy === "distance"
    ? raw.sortBy
    : DEFAULT_FILTERS.sortBy;
  return {
    longitude: finiteOr(raw.longitude, DEFAULT_FILTERS.longitude),
    latitude: finiteOr(raw.latitude, DEFAULT_FILTERS.latitude),
    radiusKm: positiveOr(raw.radiusKm, DEFAULT_FILTERS.radiusKm),
    freeText: stringOr(raw.freeText, DEFAULT_FILTERS.freeText),
    selectedBrands: [...brands],
    selectedFuel: toFuelCode(raw.selectedFuel),
    onlyAvailable: raw.onlyAvailable === true,
    sortBy,
    notificationsEnabled: raw.notificationsEnabled === true,
  };
}

export function normalizeState(input: unknown): AppState {
  const raw = (input ?? {}) as Partial<Record<keyof AppState, unknown>>;
  const trackers = raw.trackers && typeof raw.trackers === "object"
    ? (raw.trackers as Record<string, FuelTrackerState>)
    : {};
  const directory = raw.brandDirectory &&
      typeof raw.brandDirectory === "object" &&
      typeof (raw.brandDirectory as BrandDirectory).updatedAt === "string" &&
      typeof (raw.brandDirectory as BrandDirectory).brands === "object"
    ? (raw.brandDirectory as BrandDirectory)
    : EMPTY_BRAND_DIRECTORY;
  return {
    version: 1,
    filters: normalizeFilters(raw.filters),
    brandDirectory: directory,
    brandArea: typeof raw.brandArea === "string" ? raw.brandArea : null,
    trackers,
    updatedAt: typeof raw.updatedAt === "string"
      ? raw.updatedAt
      : new Date(0).toISOString(),
  };
}

export interface SerializedStation extends Omit<StationSnapshot, "fuels"> {
  readonly fuels: Record<string, FuelState>;
}

export function serializeStation(station: StationSnapshot): SerializedStation {
  const fuels: Record<string, FuelState> = {};
  for (const [fuel, state] of station.fuels) fuels[fuel] = state;
  return { ...station, fuels };
}

export function deserializeStation(
  station: SerializedStation,
): StationSnapshot {
  const fuels = new Map<FuelCode, FuelState>();
  for (const [fuel, state] of Object.entries(station.fuels)) {
    fuels.set(fuel as FuelCode, state);
  }
  return { ...station, fuels };
}

export interface PollSnapshot {
  readonly stations: SerializedStation[];
  readonly fetchedAt: string;
  readonly dataUpdatedAt: string | null;
  readonly polling: boolean;
  readonly error: string | null;
  readonly pollIntervalMs: number;
}

export const EMPTY_POLL_SNAPSHOT: PollSnapshot = {
  stations: [],
  fetchedAt: new Date(0).toISOString(),
  dataUpdatedAt: null,
  polling: false,
  error: null,
  pollIntervalMs: 0,
};
