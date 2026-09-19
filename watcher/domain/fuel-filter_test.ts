import { assertEquals } from "@std/assert";
import type { FuelCode, FuelState, StationSnapshot } from "./model.ts";
import { filterStations, hasAvailableFuel, offersFuel } from "./fuel-filter.ts";

function state(
  status: FuelState["status"],
  price: number | null = null,
): FuelState {
  return {
    status,
    price,
    updatedAt: null,
    ruptureType: null,
    ruptureStart: null,
  };
}

function station(
  id: number,
  fuels: Partial<Record<FuelCode, FuelState>>,
): StationSnapshot {
  return {
    stationId: id,
    name: `Station ${id}`,
    address: "A",
    city: "B",
    latitude: 0,
    longitude: 0,
    distanceKm: 1,
    fuels: new Map(Object.entries(fuels) as [FuelCode, FuelState][]),
  };
}

const A = station(1, {
  Gazole: state("available", 2),
  E10: state("rupture"),
});
const B = station(2, { SP98: state("rupture") });
const C = station(3, { E85: state("not_offered") });

Deno.test("offersFuel with no selection is always true", () => {
  assertEquals(offersFuel(A, []), true);
});

Deno.test("offersFuel matches available or rupture, not not_offered", () => {
  assertEquals(offersFuel(A, ["Gazole"]), true);
  assertEquals(offersFuel(A, ["E10"]), true);
  assertEquals(offersFuel(C, ["E85"]), false);
  assertEquals(offersFuel(A, ["GPLc"]), false);
});

Deno.test("hasAvailableFuel with no selection checks any fuel", () => {
  assertEquals(hasAvailableFuel(A, []), true);
  assertEquals(hasAvailableFuel(B, []), false);
});

Deno.test("hasAvailableFuel respects the selected fuels", () => {
  assertEquals(hasAvailableFuel(A, ["Gazole"]), true);
  assertEquals(hasAvailableFuel(A, ["E10"]), false);
});

Deno.test("filterStations narrows by selection and availability", () => {
  const all = [A, B, C];
  assertEquals(filterStations(all, [], false).length, 3);
  assertEquals(
    filterStations(all, [], true).map((s) => s.stationId),
    [1],
  );
  assertEquals(
    filterStations(all, ["E10"], false).map((s) => s.stationId),
    [1],
  );
  assertEquals(filterStations(all, ["E10"], true).length, 0);
});
