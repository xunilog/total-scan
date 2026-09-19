import {
  type Alert,
  type Availability,
  FUEL_CODES,
  type FuelCode,
  type FuelTrackerState,
  initialTrackerState,
  type StationSnapshot,
  trackerKey,
} from "./model.ts";

export interface DetectorOptions {
  readonly confirmations: number;
  readonly cooldownMs: number;
}

export interface DetectParams {
  readonly previous: ReadonlyMap<string, FuelTrackerState>;
  readonly snapshot: readonly StationSnapshot[];
  readonly fuels: readonly FuelCode[];
  readonly now: Date;
  readonly options: DetectorOptions;
}

export interface DetectResult {
  readonly alerts: Alert[];
  readonly next: Map<string, FuelTrackerState>;
}

interface ObservedState {
  readonly status: Availability;
  readonly price: number | null;
  readonly updatedAt: string | null;
  readonly ruptureType: string | null;
  readonly ruptureStart: string | null;
}

function observe(fuel: FuelCode, station: StationSnapshot): ObservedState {
  const state = station.fuels.get(fuel);
  if (!state || state.status === "not_offered") {
    return {
      status: "not_offered",
      price: null,
      updatedAt: null,
      ruptureType: null,
      ruptureStart: null,
    };
  }
  if (state.status === "rupture") {
    return {
      status: "rupture",
      price: null,
      updatedAt: state.updatedAt,
      ruptureType: state.ruptureType,
      ruptureStart: state.ruptureStart,
    };
  }
  return {
    status: "available",
    price: state.price,
    updatedAt: state.updatedAt,
    ruptureType: null,
    ruptureStart: null,
  };
}

interface StepResult {
  readonly state: FuelTrackerState;
  readonly becameAvailable: boolean;
}

function stepFuel(
  previous: FuelTrackerState,
  observed: ObservedState,
  options: DetectorOptions,
): StepResult {
  const confirmations = previous.candidate === observed.status
    ? previous.confirmations + 1
    : 1;
  const candidate = observed.status;
  const confirmedNow = confirmations >= options.confirmations &&
    candidate !== previous.status;

  if (confirmedNow) {
    return {
      becameAvailable: previous.status === "rupture" &&
        candidate === "available",
      state: {
        status: candidate,
        candidate,
        confirmations,
        price: observed.price,
        updatedAt: observed.updatedAt,
        ruptureType: observed.ruptureType,
        ruptureStart: observed.ruptureStart,
        lastNotifiedAt: previous.lastNotifiedAt,
      },
    };
  }

  const holding = candidate === previous.status;
  return {
    becameAvailable: false,
    state: {
      status: previous.status,
      candidate,
      confirmations,
      price: holding ? observed.price : previous.price,
      updatedAt: holding ? observed.updatedAt : previous.updatedAt,
      ruptureType: holding ? observed.ruptureType : previous.ruptureType,
      ruptureStart: holding ? observed.ruptureStart : previous.ruptureStart,
      lastNotifiedAt: previous.lastNotifiedAt,
    },
  };
}

function stationLastNotified(
  state: ReadonlyMap<string, FuelTrackerState>,
  stationId: number,
  fuels: readonly FuelCode[],
): number | null {
  let latest: number | null = null;
  for (const fuel of fuels) {
    const tracker = state.get(trackerKey(stationId, fuel));
    if (!tracker?.lastNotifiedAt) continue;
    const at = Date.parse(tracker.lastNotifiedAt);
    if (Number.isNaN(at)) continue;
    if (latest === null || at > latest) latest = at;
  }
  return latest;
}

export function detect(params: DetectParams): DetectResult {
  const { previous, snapshot, fuels, now, options } = params;
  const next = new Map(previous);
  const alerts: Alert[] = [];
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  for (const station of snapshot) {
    const confirmed: Array<{ fuel: FuelCode; state: FuelTrackerState }> = [];

    for (const fuel of fuels) {
      const key = trackerKey(station.stationId, fuel);
      const previousState = next.get(key) ?? initialTrackerState();
      const { state, becameAvailable } = stepFuel(
        previousState,
        observe(fuel, station),
        options,
      );
      next.set(key, state);
      if (becameAvailable) confirmed.push({ fuel, state });
    }

    if (confirmed.length === 0) continue;

    const lastNotified = stationLastNotified(next, station.stationId, fuels);
    const cooldownElapsed = lastNotified === null ||
      nowMs - lastNotified >= options.cooldownMs;
    if (!cooldownElapsed) continue;

    for (const { fuel, state } of confirmed) {
      if (state.price === null) continue;
      alerts.push({
        stationId: station.stationId,
        stationName: station.name,
        city: station.city,
        distanceKm: station.distanceKm,
        fuel,
        price: state.price,
        updatedAt: state.updatedAt,
        detectedAt: nowIso,
      });
      next.set(trackerKey(station.stationId, fuel), {
        ...state,
        lastNotifiedAt: nowIso,
      });
    }
  }

  return { alerts, next };
}

export function defaultFuels(): readonly FuelCode[] {
  return FUEL_CODES;
}
