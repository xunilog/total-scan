// Pure helpers shared by the Deno poller and the webview. Extracted from
// `src/App.tsx` so both sides filter, sort, and link stations identically.

import { stationMatchesBrands } from "../watcher/brands/directory.ts";
import type { GeoPoint } from "../watcher/domain/geo.ts";
import type { FuelCode, StationSnapshot } from "../watcher/domain/model.ts";
import type { SortMode } from "./app-state.ts";

export function matchesText(station: StationSnapshot, needle: string): boolean {
  const haystack = `${station.name} ${station.address} ${station.city}`
    .toLowerCase();
  return haystack.includes(needle);
}

export function matchesFilters(
  station: StationSnapshot,
  brandIndex: ReadonlyMap<number, ReadonlySet<string>>,
  brands: readonly string[],
  needle: string,
): boolean {
  if (
    brands.length > 0 &&
    !stationMatchesBrands(brandIndex, station.stationId, brands)
  ) {
    return false;
  }
  if (needle && !matchesText(station, needle)) return false;
  return true;
}

export function stationFuelPrice(
  station: StationSnapshot,
  fuel: FuelCode | null,
): number | null {
  if (!fuel) return null;
  const state = station.fuels.get(fuel);
  if (!state || state.status !== "available") return null;
  return state.price;
}

export function sortStations(
  stations: readonly StationSnapshot[],
  fuel: FuelCode | null,
  mode: SortMode,
): StationSnapshot[] {
  const byDistance = (a: StationSnapshot, b: StationSnapshot) =>
    a.distanceKm - b.distanceKm;
  if (mode !== "price" || !fuel) return [...stations].sort(byDistance);
  return [...stations].sort((a, b) => {
    const priceA = stationFuelPrice(a, fuel);
    const priceB = stationFuelPrice(b, fuel);
    if (priceA === null && priceB === null) return byDistance(a, b);
    if (priceA === null) return 1;
    if (priceB === null) return -1;
    return priceA - priceB;
  });
}

export function latestFuelMaj(
  stations: readonly StationSnapshot[],
): string | null {
  let latestMs: number | null = null;
  let latestIso: string | null = null;
  for (const station of stations) {
    for (const fuel of station.fuels.values()) {
      if (!fuel.updatedAt) continue;
      const parsed = Date.parse(fuel.updatedAt);
      if (Number.isNaN(parsed)) continue;
      if (latestMs === null || parsed > latestMs) {
        latestMs = parsed;
        latestIso = fuel.updatedAt;
      }
    }
  }
  return latestIso;
}

export function areaKey(origin: GeoPoint, radiusKm: number): string {
  return `${origin.latitude}|${origin.longitude}|${radiusKm}`;
}

export function googleMapsDirectionsUrl(
  origin: GeoPoint,
  destination: { latitude: number; longitude: number },
): string {
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.latitude},${origin.longitude}`,
    destination: `${destination.latitude},${destination.longitude}`,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${params}`;
}
