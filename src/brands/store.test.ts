import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_BRAND_DIRECTORY } from "../types.ts";
import { loadCachedBrands, saveCachedBrands } from "./store.ts";

beforeEach(() => {
  localStorage.clear();
});

describe("brand directory store", () => {
  it("round-trips a directory", () => {
    const directory = {
      updatedAt: "2026-01-01T00:00:00.000Z",
      brands: { Total: [1, 2] },
    };
    saveCachedBrands(directory);
    expect(loadCachedBrands()).toEqual(directory);
  });

  it("returns the empty directory when nothing is cached", () => {
    expect(loadCachedBrands()).toEqual(EMPTY_BRAND_DIRECTORY);
  });

  it("rejects a malformed directory", () => {
    localStorage.setItem("total-scan.brand-directory.v1", JSON.stringify({ brands: {} }));
    expect(loadCachedBrands()).toEqual(EMPTY_BRAND_DIRECTORY);
  });
});
