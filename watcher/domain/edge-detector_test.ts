import { assertEquals } from "@std/assert";
import { detect } from "./edge-detector.ts";
import type {
  FuelCode,
  FuelState,
  FuelTrackerState,
  StationSnapshot,
} from "./model.ts";

const GAZOLE: FuelCode = "Gazole";
const OPTIONS = { confirmations: 2, cooldownMs: 6 * 60 * 60 * 1000 };
const T0 = Date.parse("2026-01-01T00:00:00Z");

function available(price = 2.1): FuelState {
  return {
    status: "available",
    price,
    updatedAt: "2026-01-01T00:00:00Z",
    ruptureType: null,
    ruptureStart: null,
  };
}

function rupture(): FuelState {
  return {
    status: "rupture",
    price: null,
    updatedAt: "2026-01-01T00:00:00Z",
    ruptureType: "temporaire",
    ruptureStart: "2025-12-31T00:00:00Z",
  };
}

function notOffered(): FuelState {
  return {
    status: "not_offered",
    price: null,
    updatedAt: null,
    ruptureType: null,
    ruptureStart: null,
  };
}

function station(state: FuelState, id = 1): StationSnapshot {
  return {
    stationId: id,
    name: "Station",
    address: "1 rue",
    city: "Ville",
    latitude: 48,
    longitude: 2,
    distanceKm: 3,
    fuels: new Map([[GAZOLE, state]]),
  };
}

function tick(
  previous: ReadonlyMap<string, FuelTrackerState>,
  state: FuelState,
  offsetMs: number,
): ReturnType<typeof detect> {
  return detect({
    previous,
    snapshot: [station(state)],
    fuels: [GAZOLE],
    now: new Date(T0 + offsetMs),
    options: OPTIONS,
  });
}

function settle(
  previous: ReadonlyMap<string, FuelTrackerState>,
  state: FuelState,
  startMs: number,
): { next: Map<string, FuelTrackerState>; alerts: number } {
  let result = tick(previous, state, startMs);
  result = tick(result.next, state, startMs + 60_000);
  return { next: result.next, alerts: result.alerts.length };
}

Deno.test("fires once on rupture -> available after confirmations", () => {
  const ruptured = settle(new Map(), rupture(), 0);
  assertEquals(ruptured.alerts, 0);

  const firstAvailable = tick(ruptured.next, available(), 120_000);
  assertEquals(firstAvailable.alerts.length, 0);

  const secondAvailable = tick(firstAvailable.next, available(), 180_000);
  assertEquals(secondAvailable.alerts.length, 1);
  assertEquals(secondAvailable.alerts[0].fuel, GAZOLE);
  assertEquals(secondAvailable.alerts[0].price, 2.1);
});

Deno.test("does not fire on available -> rupture", () => {
  const started = settle(new Map(), available(), 0);
  assertEquals(started.alerts, 0);
  const out = settle(started.next, rupture(), 120_000);
  assertEquals(out.alerts, 0);
});

Deno.test("does not fire when fuel was absent (not offered) before", () => {
  const absent = settle(new Map(), notOffered(), 0);
  const nowAvailable = settle(absent.next, available(), 120_000);
  assertEquals(nowAvailable.alerts, 0);
});

Deno.test("cooldown suppresses a second alert for the same station", () => {
  const ruptured = settle(new Map(), rupture(), 0);
  const first = settle(ruptured.next, available(), 120_000);
  assertEquals(first.alerts, 1);

  const again = settle(first.next, available(), 240_000);
  assertEquals(again.alerts, 0);

  const rupturedAgain = settle(again.next, rupture(), 360_000);
  assertEquals(rupturedAgain.alerts, 0);
  const withinCooldown = settle(rupturedAgain.next, available(), 480_000);
  assertEquals(withinCooldown.alerts, 0);

  const afterCooldown = settle(
    withinCooldown.next,
    available(),
    OPTIONS.cooldownMs + 600_000,
  );
  assertEquals(afterCooldown.alerts, 0);
  const rupturedLater = settle(
    afterCooldown.next,
    rupture(),
    OPTIONS.cooldownMs + 720_000,
  );
  assertEquals(rupturedLater.alerts, 0);
  const availableLater = settle(
    rupturedLater.next,
    available(),
    OPTIONS.cooldownMs + 840_000,
  );
  assertEquals(availableLater.alerts, 1);
});

Deno.test("stable available updates price without alerting", () => {
  const started = settle(new Map(), available(2.0), 0);
  const repriced = settle(started.next, available(1.95), 120_000);
  assertEquals(repriced.alerts, 0);
  assertEquals(repriced.next.get("1:Gazole")?.price, 1.95);
});
