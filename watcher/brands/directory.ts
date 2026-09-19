import { type GeoPoint, haversineKm } from "../domain/geo.ts";

export interface BrandDirectory {
  readonly updatedAt: string;
  readonly brands: Readonly<Record<string, readonly number[]>>;
}

export interface ObservedBrand {
  readonly brand: string;
  readonly latitude: number;
  readonly longitude: number;
}

export interface GeoStation {
  readonly stationId: number;
  readonly latitude: number;
  readonly longitude: number;
}

export const EMPTY_BRAND_DIRECTORY: BrandDirectory = {
  updatedAt: new Date(0).toISOString(),
  brands: {},
};

export function brandNames(directory: BrandDirectory): string[] {
  return Object.keys(directory.brands).sort((a, b) => a.localeCompare(b));
}

export function mergeBrandDirectories(
  base: BrandDirectory,
  incoming: BrandDirectory,
): BrandDirectory {
  const brands: Record<string, number[]> = {};
  for (const [brand, ids] of Object.entries(base.brands)) {
    brands[brand] = [...ids];
  }
  for (const [brand, ids] of Object.entries(incoming.brands)) {
    const merged = new Set(brands[brand] ?? []);
    for (const id of ids) merged.add(id);
    brands[brand] = [...merged].sort((a, b) => a - b);
  }
  return { updatedAt: incoming.updatedAt, brands };
}

export function matchBrands(
  observed: readonly ObservedBrand[],
  stations: readonly GeoStation[],
  thresholdKm: number,
): Record<string, number[]> {
  const byBrand = new Map<string, Set<number>>();

  for (const item of observed) {
    const brand = item.brand.trim();
    if (brand === "") continue;

    const point: GeoPoint = {
      latitude: item.latitude,
      longitude: item.longitude,
    };
    let nearest: { id: number; distanceKm: number } | null = null;
    for (const station of stations) {
      const distanceKm = haversineKm(point, {
        latitude: station.latitude,
        longitude: station.longitude,
      });
      if (distanceKm > thresholdKm) continue;
      if (nearest === null || distanceKm < nearest.distanceKm) {
        nearest = { id: station.stationId, distanceKm };
      }
    }
    if (nearest === null) continue;

    const ids = byBrand.get(brand) ?? new Set<number>();
    ids.add(nearest.id);
    byBrand.set(brand, ids);
  }

  const brands: Record<string, number[]> = {};
  for (const [brand, ids] of byBrand) {
    brands[brand] = [...ids].sort((a, b) => a - b);
  }
  return brands;
}

export function buildBrandIndex(
  directory: BrandDirectory,
): Map<number, Set<string>> {
  const index = new Map<number, Set<string>>();
  for (const [brand, ids] of Object.entries(directory.brands)) {
    for (const id of ids) {
      const brands = index.get(id) ?? new Set<string>();
      brands.add(brand);
      index.set(id, brands);
    }
  }
  return index;
}

export function stationMatchesBrands(
  index: ReadonlyMap<number, ReadonlySet<string>>,
  stationId: number,
  selected: readonly string[],
): boolean {
  if (selected.length === 0) return true;
  const brands = index.get(stationId);
  if (!brands) return false;
  return selected.some((brand) => brands.has(brand));
}
