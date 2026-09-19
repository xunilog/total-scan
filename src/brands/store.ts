import type { BrandDirectory } from "../types.ts";
import { EMPTY_BRAND_DIRECTORY } from "../types.ts";

const STORAGE_KEY = "total-scan.brand-directory.v1";

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
