import { assertEquals } from "@std/assert";
import {
  type BrandDirectory,
  brandNames,
  buildBrandIndex,
  matchBrands,
  mergeBrandDirectories,
  stationMatchesBrands,
} from "./directory.ts";

Deno.test("merge unions ids per brand and keeps incoming updatedAt", () => {
  const base: BrandDirectory = {
    updatedAt: "2026-01-01T00:00:00Z",
    brands: { Total: [1, 2], Esso: [5] },
  };
  const incoming: BrandDirectory = {
    updatedAt: "2026-01-02T00:00:00Z",
    brands: { Total: [2, 3], Shell: [9] },
  };
  const merged = mergeBrandDirectories(base, incoming);
  assertEquals(merged.updatedAt, "2026-01-02T00:00:00Z");
  assertEquals(merged.brands.Total, [1, 2, 3]);
  assertEquals(merged.brands.Esso, [5]);
  assertEquals(merged.brands.Shell, [9]);
});

Deno.test("matchBrands keeps the nearest station within the threshold", () => {
  const observed = [
    { brand: "TotalEnergies", latitude: 48.58, longitude: 7.68 },
    { brand: "Esso", latitude: 48.7, longitude: 7.9 },
  ];
  const stations = [
    { stationId: 10, latitude: 48.5801, longitude: 7.6801 },
    { stationId: 11, latitude: 48.5802, longitude: 7.6802 },
  ];
  const brands = matchBrands(observed, stations, 0.15);
  assertEquals(brands.TotalEnergies, [10]);
  assertEquals(brands.Esso, undefined);
});

Deno.test("matchBrands ignores stations farther than the threshold", () => {
  const observed = [{ brand: "Shell", latitude: 48.58, longitude: 7.68 }];
  const stations = [{ stationId: 42, latitude: 49.0, longitude: 8.0 }];
  assertEquals(matchBrands(observed, stations, 0.15), {});
});

Deno.test("brandNames is sorted", () => {
  const directory: BrandDirectory = {
    updatedAt: "2026-01-01T00:00:00Z",
    brands: { Shell: [1], Esso: [2], Total: [3] },
  };
  assertEquals(brandNames(directory), ["Esso", "Shell", "Total"]);
});

Deno.test("brand index filters stations by selected brands", () => {
  const directory: BrandDirectory = {
    updatedAt: "2026-01-01T00:00:00Z",
    brands: { Total: [1], Esso: [2] },
  };
  const index = buildBrandIndex(directory);
  assertEquals(stationMatchesBrands(index, 1, ["Total"]), true);
  assertEquals(stationMatchesBrands(index, 1, ["Esso"]), false);
  assertEquals(stationMatchesBrands(index, 3, ["Total"]), false);
  assertEquals(stationMatchesBrands(index, 9, []), true);
});
