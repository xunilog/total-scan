import { beforeEach, describe, expect, it } from "vitest";
import { loadFilters, saveFilters } from "./store.ts";

beforeEach(() => {
  localStorage.clear();
});

describe("filters store", () => {
  it("round-trips a filter state", () => {
    saveFilters({
      longitude: 7.68,
      latitude: 48.58,
      radiusKm: 10,
      freeText: "Sens",
      selectedBrands: ["Total"],
      selectedFuel: "Gazole",
      onlyAvailable: true,
      sortBy: "price",
      notificationsEnabled: true,
    });
    const loaded = loadFilters();
    expect(loaded.longitude).toBe(7.68);
    expect(loaded.latitude).toBe(48.58);
    expect(loaded.radiusKm).toBe(10);
    expect(loaded.freeText).toBe("Sens");
    expect(loaded.selectedBrands).toEqual(["Total"]);
    expect(loaded.selectedFuel).toBe("Gazole");
    expect(loaded.onlyAvailable).toBe(true);
    expect(loaded.sortBy).toBe("price");
    expect(loaded.notificationsEnabled).toBe(true);
  });

  it("drops junk values", () => {
    localStorage.setItem(
      "total-scan.filters.v1",
      JSON.stringify({
        longitude: "3.5",
        radiusKm: -1,
        selectedBrands: ["A", 2, "B"],
        selectedFuel: 7,
        onlyAvailable: "yes",
        sortBy: "bogus",
      }),
    );
    const loaded = loadFilters();
    expect(loaded.longitude).toBe("3.5");
    expect(loaded.radiusKm).toBe(-1);
    expect(loaded.selectedBrands).toEqual(["A", "B"]);
    expect(loaded.selectedFuel).toBeUndefined();
    expect(loaded.onlyAvailable).toBeUndefined();
    expect(loaded.sortBy).toBeUndefined();
  });

  it("returns an empty object for corrupt JSON", () => {
    localStorage.setItem("total-scan.filters.v1", "{not json");
    expect(loadFilters()).toEqual({});
  });
});
