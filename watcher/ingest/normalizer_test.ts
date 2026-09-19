import { assertEquals } from "@std/assert";
import { normalizeFrenchTimestamp, normalizeStation } from "./normalizer.ts";
import type { FuelCode } from "../domain/model.ts";

const FUELS: readonly FuelCode[] = [
  "Gazole",
  "SP95",
  "E10",
  "SP98",
  "E85",
  "GPLc",
];
const ORIGIN = { latitude: 48.8566, longitude: 2.3522 };

Deno.test("classifies available, rupture and not offered", () => {
  const record = {
    id: 89100001,
    geom: { lon: 3.309, lat: 48.183 },
    adresse: "84 ROUTE DE MAILLOT",
    ville: "Sens",
    gazole_prix: 2.469,
    gazole_maj: "2026-09-18T09:07:28+00:00",
    gazole_rupture_type: null,
    sp95_prix: null,
    sp95_rupture_type: "definitive",
    sp95_rupture_debut: "2022-11-26T09:30:22+00:00",
    carburants_disponibles: ["Gazole", "E85", "E10", "SP98"],
    carburants_indisponibles: ["SP95", "GPLc"],
  };

  const station = normalizeStation(record, ORIGIN, FUELS);
  assertEquals(station?.fuels.get("Gazole")?.status, "available");
  assertEquals(station?.fuels.get("Gazole")?.price, 2.469);
  assertEquals(station?.fuels.get("SP95")?.status, "rupture");
  assertEquals(station?.fuels.get("SP95")?.ruptureType, "definitive");
  assertEquals(station?.fuels.get("GPLc")?.status, "rupture");
  assertEquals(station?.fuels.get("E10")?.status, "available");
  assertEquals(station?.fuels.get("E10")?.price, null);
});

Deno.test("treats a fuel with no price and no rupture as not offered", () => {
  const record = {
    id: 1,
    geom: { lon: 2.35, lat: 48.85 },
    adresse: "A",
    ville: "B",
    carburants_disponibles: null,
    carburants_indisponibles: null,
  };
  const station = normalizeStation(record, ORIGIN, FUELS);
  assertEquals(station?.fuels.get("SP98")?.status, "not_offered");
  assertEquals(station?.fuels.get("SP98")?.price, null);
});

Deno.test("falls back to scaled integer coordinates", () => {
  const record = {
    id: 2,
    latitude: "4818300",
    longitude: "330900",
    adresse: "A",
    ville: "B",
  };
  const station = normalizeStation(record, ORIGIN, FUELS);
  assertEquals(station?.latitude, 48.183);
  assertEquals(station?.longitude, 3.309);
});

Deno.test("computes a plausible distance from the origin", () => {
  const record = { id: 3, geom: { lon: 2.3522, lat: 48.8566 } };
  const station = normalizeStation(record, ORIGIN, FUELS);
  assertEquals(station?.distanceKm, 0);
});

Deno.test("parses semicolon-delimited fuel lists", () => {
  const record = {
    id: 4,
    geom: { lon: 2.35, lat: 48.85 },
    carburants_disponibles: "Gazole;E10",
    carburants_indisponibles: "SP95",
    sp95_rupture_type: "temporaire",
  };
  const station = normalizeStation(record, ORIGIN, FUELS);
  assertEquals(station?.fuels.get("Gazole")?.status, "available");
  assertEquals(station?.fuels.get("E10")?.status, "available");
  assertEquals(station?.fuels.get("SP95")?.status, "rupture");
  assertEquals(station?.fuels.get("SP95")?.ruptureType, "temporaire");
});

Deno.test("reinterprets French local timestamps labelled as UTC", () => {
  // Summer time (CEST, UTC+2).
  assertEquals(
    normalizeFrenchTimestamp("2026-09-18T18:49:25+00:00"),
    "2026-09-18T16:49:25.000Z",
  );
  // Winter time (CET, UTC+1).
  assertEquals(
    normalizeFrenchTimestamp("2026-01-15T08:30:00+00:00"),
    "2026-01-15T07:30:00.000Z",
  );
  // Naive wall-clock without timezone.
  assertEquals(
    normalizeFrenchTimestamp("2026-09-18 18:49:25"),
    "2026-09-18T16:49:25.000Z",
  );
  assertEquals(normalizeFrenchTimestamp("not a date"), null);
});
