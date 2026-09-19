import {
  type BrandDirectory,
  EMPTY_BRAND_DIRECTORY,
} from "../../watcher/brands/directory.ts";

const STORAGE_KEY = "total-scan.brand-directory.v1";
const AREA_KEY = "total-scan.brand-directory.area.v1";
export const BRAND_TTL_MS = 60 * 60 * 1000;

export function loadCachedBrands(): BrandDirectory {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_BRAND_DIRECTORY;
    const parsed = JSON.parse(raw) as BrandDirectory;
    if (
      !parsed ||
      typeof parsed.updatedAt !== "string" ||
      typeof parsed.brands !== "object" ||
      parsed.brands === null
    ) {
      return EMPTY_BRAND_DIRECTORY;
    }
    return parsed;
  } catch {
    return EMPTY_BRAND_DIRECTORY;
  }
}

export function saveCachedBrands(directory: BrandDirectory): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(directory));
  } catch {
    return;
  }
}

export function isBrandCacheStale(
  directory: BrandDirectory,
  nowMs: number,
): boolean {
  const updated = Date.parse(directory.updatedAt);
  if (Number.isNaN(updated)) return true;
  return nowMs - updated >= BRAND_TTL_MS;
}

export function hasFetchedBrands(directory: BrandDirectory): boolean {
  const updated = Date.parse(directory.updatedAt);
  return Number.isFinite(updated) && updated > 0;
}

export function loadBrandArea(): string | null {
  try {
    return globalThis.localStorage?.getItem(AREA_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveBrandArea(area: string): void {
  try {
    globalThis.localStorage?.setItem(AREA_KEY, area);
  } catch {
    return;
  }
}
