// Deno-side poll loop for the desktop app.
//
// This is the piece that makes tray-only operation work: it runs inside the
// `deno desktop` process, independent of any webview, reading the user's
// criteria from the shared `AppState` and raising OS notifications on
// rupture -> available transitions. The webview only reads the results.
//
// The headless `watcher/` process is untouched; this reuses its pure domain
// logic (feed, normalizer, edge detector, brand directory).

import { buildBrandIndex } from "./watcher/brands/directory.ts";
import { refreshBrandDirectory } from "./watcher/brands/overpass.ts";
import { detect } from "./watcher/domain/edge-detector.ts";
import {
  type Alert,
  FUEL_CODES,
  type StationSnapshot,
} from "./watcher/domain/model.ts";
import type { GeoPoint } from "./watcher/domain/geo.ts";
import { createOdsFeed } from "./watcher/feed/ods-feed.ts";
import { normalizeStations } from "./watcher/ingest/normalizer.ts";
import type { Logger } from "./watcher/ports.ts";
import { createConsoleLogger } from "./watcher/util/log.ts";
import {
  type AppFilters,
  type AppState,
  type PollSnapshot,
  serializeStation,
} from "./shared/app-state.ts";
import {
  areaKey,
  googleMapsDirectionsUrl,
  latestFuelMaj,
  matchesFilters,
} from "./shared/station-query.ts";
import type { DesktopNotifier } from "./notify.ts";
import { saveState } from "./state-store.ts";

const ODS = {
  baseUrl: "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets",
  datasetId: "prix-des-carburants-en-france-flux-instantane-v2",
};

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const BRAND_TTL_MS = 60 * 60 * 1000;
const CONFIRMATIONS = 2;
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface PollerOptions {
  readonly state: AppState;
  readonly notifier: DesktopNotifier;
  readonly logger?: Logger;
  readonly stateFile?: string;
  readonly pollIntervalMs?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DesktopPoller {
  #state: AppState;
  #snapshot: PollSnapshot;
  #running = false;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #tickPromise: Promise<void> | null = null;
  #tickQueued = false;
  #lastBrandRefresh = 0;
  readonly #notifier: DesktopNotifier;
  readonly #logger: Logger;
  readonly #stateFile: string | undefined;
  readonly #pollIntervalMs: number;

  constructor(options: PollerOptions) {
    this.#state = options.state;
    this.#notifier = options.notifier;
    this.#logger = options.logger ?? createConsoleLogger();
    this.#stateFile = options.stateFile;
    this.#pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.#snapshot = {
      stations: [],
      fetchedAt: new Date(0).toISOString(),
      dataUpdatedAt: null,
      polling: false,
      error: null,
      pollIntervalMs: this.#pollIntervalMs,
    };
  }

  getState(): AppState {
    return this.#state;
  }

  getSnapshot(): PollSnapshot {
    return this.#snapshot;
  }

  notificationsAvailable(): boolean {
    return this.#notifier.available();
  }

  requestNotificationPermission(): Promise<boolean> {
    return this.#notifier.requestPermission();
  }

  async updateFilters(filters: AppFilters): Promise<AppState> {
    this.#state = {
      ...this.#state,
      filters,
      updatedAt: new Date().toISOString(),
    };
    await this.#persist();
    this.#logger.info("filters updated", {
      radiusKm: filters.radiusKm,
      fuels: filters.selectedFuel ?? "all",
      brands: filters.selectedBrands.length,
    });
    void this.tick();
    return this.#state;
  }

  /**
   * Force a poll and resolve once it has produced a snapshot. If a tick is
   * already running, that one is awaited (its data is fresh enough); a follow-up
   * tick is queued so filter changes made mid-tick are still picked up.
   */
  async refresh(): Promise<void> {
    await this.tick();
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.tick();
    this.#schedulePoll();
  }

  stop(): void {
    this.#running = false;
    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  /** Serialize ticks; returns the in-flight tick when one is already running. */
  tick(): Promise<void> {
    if (this.#tickPromise !== null) {
      this.#tickQueued = true;
      return this.#tickPromise;
    }
    const run = this.#runTick();
    this.#tickPromise = run;
    run.finally(() => {
      if (this.#tickPromise === run) this.#tickPromise = null;
      if (this.#tickQueued) {
        this.#tickQueued = false;
        void this.tick();
      }
    });
    return run;
  }

  async #runTick(): Promise<void> {
    const startedAt = new Date();
    const { filters } = this.#state;
    const origin: GeoPoint = {
      latitude: filters.latitude,
      longitude: filters.longitude,
    };

    try {
      await this.#refreshBrandsIfNeeded(origin, filters.radiusKm);

      const feed = createOdsFeed(ODS, this.#logger);
      const records = await feed.fetchRecords({
        origin,
        radiusKm: filters.radiusKm,
      });
      const stations = normalizeStations(records, origin, FUEL_CODES);

      const brandIndex = buildBrandIndex(this.#state.brandDirectory);
      const needle = filters.freeText.trim().toLowerCase();
      const matching = stations.filter((station) =>
        matchesFilters(station, brandIndex, filters.selectedBrands, needle)
      );

      const previous = new Map(Object.entries(this.#state.trackers));
      const fuels = filters.selectedFuel ? [filters.selectedFuel] : FUEL_CODES;
      const result = detect({
        previous,
        snapshot: matching,
        fuels,
        now: startedAt,
        options: { confirmations: CONFIRMATIONS, cooldownMs: COOLDOWN_MS },
      });

      this.#state = {
        ...this.#state,
        trackers: Object.fromEntries(result.next),
        updatedAt: startedAt.toISOString(),
      };
      await this.#persist();

      this.#snapshot = {
        stations: stations.map(serializeStation),
        fetchedAt: startedAt.toISOString(),
        dataUpdatedAt: latestFuelMaj(stations),
        polling: false,
        error: null,
        pollIntervalMs: this.#pollIntervalMs,
      };

      await this.#notify(result.alerts, matching, origin, filters);

      this.#logger.info("poll complete", {
        inRadius: stations.length,
        matching: matching.length,
        alerts: result.alerts.length,
      });
    } catch (error) {
      this.#snapshot = {
        ...this.#snapshot,
        fetchedAt: startedAt.toISOString(),
        polling: false,
        error: errorMessage(error),
      };
      this.#logger.error("poll failed", { error: errorMessage(error) });
    }
  }

  async #notify(
    alerts: readonly Alert[],
    stations: readonly StationSnapshot[],
    origin: GeoPoint,
    filters: AppFilters,
  ): Promise<void> {
    if (alerts.length === 0) return;
    if (!filters.notificationsEnabled) {
      this.#logger.info("alerts suppressed (notifications disabled)", {
        alerts: alerts.length,
      });
      return;
    }
    if (!this.#notifier.available()) {
      this.#logger.warn("notifications unavailable in this runtime", {
        alerts: alerts.length,
      });
      return;
    }

    const byId = new Map(
      stations.map((station) => [station.stationId, station]),
    );
    for (const alert of alerts) {
      const station = byId.get(alert.stationId);
      const body = [
        `${alert.fuel} : ${alert.price.toFixed(3)} EUR/L`,
        alert.stationName,
        `Distance : ${alert.distanceKm.toFixed(1)} km`,
        alert.updatedAt
          ? `Maj station : ${alert.updatedAt}`
          : "Maj station : inconnue",
        "Disponibilite declaree par la station: a verifier par telephone.",
      ].join("\n");
      await this.#notifier.notify({
        title: `${alert.fuel} disponible - ${alert.city || alert.stationName}`,
        body,
        tag: `station-${alert.stationId}-${alert.fuel}`,
        url: station ? googleMapsDirectionsUrl(origin, station) : undefined,
      });
      this.#logger.info("alert delivered", {
        stationId: alert.stationId,
        fuel: alert.fuel,
      });
    }
  }

  async #refreshBrandsIfNeeded(
    origin: GeoPoint,
    radiusKm: number,
  ): Promise<void> {
    const area = areaKey(origin, radiusKm);
    const now = Date.now();
    const stale = now - this.#lastBrandRefresh >= BRAND_TTL_MS;
    if (this.#state.brandArea === area && !stale) return;

    try {
      const feed = createOdsFeed(ODS, this.#logger);
      const result = await refreshBrandDirectory(
        { origin, radiusKm, feed },
        this.#state.brandDirectory,
      );
      this.#state = {
        ...this.#state,
        brandDirectory: result.directory,
        brandArea: area,
      };
      this.#lastBrandRefresh = now;
      await this.#persist();
      this.#logger.info("brand directory refreshed", {
        osmStations: result.osmStations,
        matchedStations: result.matchedStations,
      });
    } catch (error) {
      this.#logger.warn("brand refresh failed", {
        error: errorMessage(error),
      });
    }
  }

  #persist(): Promise<void> {
    return saveState(this.#state, this.#stateFile).catch((error: unknown) => {
      this.#logger.error("failed to persist state", {
        error: errorMessage(error),
      });
    });
  }

  #schedulePoll(): void {
    if (!this.#running) return;
    this.#pollTimer = setTimeout(() => {
      void this.tick().finally(() => this.#schedulePoll());
    }, this.#pollIntervalMs);
  }
}
