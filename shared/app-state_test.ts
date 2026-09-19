import { assertEquals } from "@std/assert";
import {
  deserializeStation,
  normalizeFilters,
  normalizeState,
  serializeStation,
} from "./app-state.ts";
import { googleMapsDirectionsUrl } from "./station-query.ts";
import type { StationSnapshot } from "../watcher/domain/model.ts";

const STATION: StationSnapshot = {
  stationId: 42,
  name: "Total, Bordeaux",
  address: "1 rue X",
  city: "Bordeaux",
  latitude: 44.84,
  longitude: -0.58,
  distanceKm: 1.2,
  fuels: new Map([
    ["Gazole", {
      status: "available",
      price: 1.789,
      updatedAt: "2026-09-18T10:00:00.000Z",
      ruptureType: null,
      ruptureStart: null,
    }],
    ["SP98", {
      status: "rupture",
      price: null,
      updatedAt: null,
      ruptureType: "temporaire",
      ruptureStart: null,
    }],
  ]),
};

Deno.test("serializeStation round-trips the fuels map", () => {
  const restored = deserializeStation(serializeStation(STATION));
  assertEquals(restored.stationId, 42);
  assertEquals(restored.fuels.size, 2);
  assertEquals(restored.fuels.get("Gazole"), {
    status: "available",
    price: 1.789,
    updatedAt: "2026-09-18T10:00:00.000Z",
    ruptureType: null,
    ruptureStart: null,
  });
  assertEquals(restored.fuels.get("SP98")?.status, "rupture");
});

Deno.test("normalizeFilters falls back to defaults", () => {
  const filters = normalizeFilters(null);
  assertEquals(filters.longitude, 7.687329);
  assertEquals(filters.latitude, 48.579682);
  assertEquals(filters.radiusKm, 10);
  assertEquals(filters.selectedFuel, null);
  assertEquals(filters.notificationsEnabled, false);
  assertEquals(filters.selectedBrands, []);
});

Deno.test("normalizeFilters coerces numbers and drops junk", () => {
  const filters = normalizeFilters({
    longitude: "3.5",
    radiusKm: -1,
    selectedFuel: "Gazole",
    notificationsEnabled: true,
    selectedBrands: ["A", 2, "B"],
  });
  assertEquals(filters.longitude, 3.5);
  assertEquals(filters.radiusKm, 10);
  assertEquals(filters.selectedFuel, "Gazole");
  assertEquals(filters.notificationsEnabled, true);
  assertEquals(filters.selectedBrands, ["A", "B"]);
});

Deno.test("normalizeState rejects unknown fuels and bad directories", () => {
  const state = normalizeState({
    filters: { selectedFuel: "Diesel" },
    brandDirectory: { brands: {} },
  });
  assertEquals(state.filters.selectedFuel, null);
  assertEquals(state.brandDirectory.brands, {});
  assertEquals(state.trackers, {});
});

Deno.test("googleMapsDirectionsUrl points from origin to station", () => {
  const url = googleMapsDirectionsUrl(
    { latitude: 48.5, longitude: 7.6 },
    { latitude: 48.6, longitude: 7.7 },
  );
  assertEquals(url.startsWith("https://www.google.com/maps/dir/?"), true);
  assertEquals(url.includes("origin=48.5%2C7.6"), true);
  assertEquals(url.includes("destination=48.6%2C7.7"), true);
});
