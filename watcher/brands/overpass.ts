import { FUEL_CODES } from "../domain/model.ts";
import type { GeoPoint } from "../domain/geo.ts";
import { normalizeStations } from "../ingest/normalizer.ts";
import type { FuelFeed } from "../ports.ts";
import {
  type BrandDirectory,
  EMPTY_BRAND_DIRECTORY,
  type GeoStation,
  matchBrands,
  mergeBrandDirectories,
  type ObservedBrand,
} from "./directory.ts";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const MATCH_THRESHOLD_KM = 0.15;
const OVERPASS_TIMEOUT_MS = 30_000;

interface OverpassElement {
  readonly lat?: number;
  readonly lon?: number;
  readonly tags?: Record<string, string>;
}

interface OverpassResponse {
  readonly elements?: readonly OverpassElement[];
}

export interface BrandRefreshParams {
  readonly origin: GeoPoint;
  readonly radiusKm: number;
  readonly feed: FuelFeed;
}

export interface BrandRefreshResult {
  readonly directory: BrandDirectory;
  readonly osmStations: number;
  readonly matchedStations: number;
}

async function fetchFromEndpoint(
  endpoint: string,
  query: string,
): Promise<OverpassResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Overpass ${endpoint} responded ${response.status}`);
  }
  return (await response.json()) as OverpassResponse;
}

export async function fetchObservedBrands(
  origin: GeoPoint,
  radiusKm: number,
): Promise<ObservedBrand[]> {
  const radiusMeters = Math.round(radiusKm * 1000);
  const query =
    `[out:json][timeout:25];node["amenity"="fuel"]["brand"](around:${radiusMeters},${origin.latitude},${origin.longitude});out body;`;

  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const body = await fetchFromEndpoint(endpoint, query);
      return (body.elements ?? [])
        .map((element) => ({
          brand: element.tags?.brand ?? "",
          latitude: element.lat ?? Number.NaN,
          longitude: element.lon ?? Number.NaN,
        }))
        .filter((item) =>
          item.brand.trim() !== "" &&
          Number.isFinite(item.latitude) &&
          Number.isFinite(item.longitude)
        );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Overpass unreachable");
}

export async function refreshBrandDirectory(
  params: BrandRefreshParams,
  existing: BrandDirectory = EMPTY_BRAND_DIRECTORY,
): Promise<BrandRefreshResult> {
  const [observed, records] = await Promise.all([
    fetchObservedBrands(params.origin, params.radiusKm),
    params.feed.fetchRecords({
      origin: params.origin,
      radiusKm: params.radiusKm,
    }),
  ]);

  const stations: GeoStation[] = normalizeStations(
    records,
    params.origin,
    FUEL_CODES,
  ).map((station) => ({
    stationId: station.stationId,
    latitude: station.latitude,
    longitude: station.longitude,
  }));

  const brands = matchBrands(observed, stations, MATCH_THRESHOLD_KM);
  const directory = mergeBrandDirectories(existing, {
    updatedAt: new Date().toISOString(),
    brands,
  });

  const matchedStations = new Set(Object.values(brands).flat()).size;
  return { directory, osmStations: observed.length, matchedStations };
}
