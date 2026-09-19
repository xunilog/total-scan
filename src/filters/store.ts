import type { SortMode } from "../types.ts";

export interface FilterState {
  readonly longitude: number | string;
  readonly latitude: number | string;
  readonly radiusKm: number | string;
  readonly freeText: string;
  readonly selectedBrands: readonly string[];
  readonly selectedFuel: string | null;
  readonly onlyAvailable: boolean;
  readonly sortBy: SortMode;
  readonly notificationsEnabled?: boolean;
}

const STORAGE_KEY = "total-scan.filters.v1";

type MutablePartial<T> = { -readonly [K in keyof T]?: T[K] };

function isNumberOrString(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

export function loadFilters(): Partial<FilterState> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};

    const result: MutablePartial<FilterState> = {};
    if (isNumberOrString(parsed.longitude)) result.longitude = parsed.longitude;
    if (isNumberOrString(parsed.latitude)) result.latitude = parsed.latitude;
    if (isNumberOrString(parsed.radiusKm)) result.radiusKm = parsed.radiusKm;
    if (typeof parsed.freeText === "string") result.freeText = parsed.freeText;
    if (Array.isArray(parsed.selectedBrands)) {
      result.selectedBrands = parsed.selectedBrands.filter(
        (brand): brand is string => typeof brand === "string",
      );
    }
    if (parsed.selectedFuel === null || typeof parsed.selectedFuel === "string") {
      result.selectedFuel = parsed.selectedFuel as string | null;
    }
    if (typeof parsed.onlyAvailable === "boolean") {
      result.onlyAvailable = parsed.onlyAvailable;
    }
    if (parsed.sortBy === "price" || parsed.sortBy === "distance") {
      result.sortBy = parsed.sortBy;
    }
    if (typeof parsed.notificationsEnabled === "boolean") {
      result.notificationsEnabled = parsed.notificationsEnabled;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveFilters(state: FilterState): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}
