import type { WatcherConfig } from "../config.ts";
import { detect } from "../domain/edge-detector.ts";
import type { Alert, StationSnapshot } from "../domain/model.ts";
import { normalizeStations } from "../ingest/normalizer.ts";
import type {
  AlertMessage,
  Clock,
  FeedQuery,
  FuelFeed,
  Logger,
  Notifier,
  StateStore,
  StationFilter,
} from "../ports.ts";

export interface PollLoopDeps {
  readonly config: WatcherConfig;
  readonly feed: FuelFeed;
  readonly store: StateStore;
  readonly notifier: Notifier;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly selector: StationFilter;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatAlert(alert: Alert): AlertMessage {
  const body = [
    `${alert.fuel} : ${alert.price.toFixed(3)} EUR/L`,
    alert.stationName,
    `Distance : ${alert.distanceKm.toFixed(1)} km`,
    alert.updatedAt
      ? `Maj station : ${alert.updatedAt}`
      : "Maj station : inconnue",
    "Disponibilite declaree par la station: a verifier par telephone.",
  ].join("\n");
  return {
    title: `${alert.fuel} disponible - ${alert.city || alert.stationName}`,
    body,
    priority: "high",
    tags: ["fuel", "rotating_light"],
  };
}

function latestMaj(stations: readonly StationSnapshot[]): string | null {
  let latestMs: number | null = null;
  let latestIso: string | null = null;
  for (const station of stations) {
    for (const fuel of station.fuels.values()) {
      if (!fuel.updatedAt) continue;
      const parsed = Date.parse(fuel.updatedAt);
      if (Number.isNaN(parsed)) continue;
      if (latestMs === null || parsed > latestMs) {
        latestMs = parsed;
        latestIso = fuel.updatedAt;
      }
    }
  }
  return latestIso;
}

export class PollLoop {
  #candidateIds = new Set<number>();
  #lastDirectoryRefresh = 0;
  #running = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: PollLoopDeps) {}

  async tick(): Promise<void> {
    const { config, feed, store, notifier, clock, logger, selector } =
      this.deps;
    const now = clock.now();
    const query: FeedQuery = {
      origin: config.origin,
      radiusKm: config.radiusKm,
    };

    const records = await feed.fetchRecords(query);
    const stations = normalizeStations(records, config.origin, config.fuels);

    if (
      now.getTime() - this.#lastDirectoryRefresh >= config.directoryRefreshMs
    ) {
      this.#candidateIds = new Set(
        stations.filter(selector).map((station) => station.stationId),
      );
      this.#lastDirectoryRefresh = now.getTime();
      logger.info("station directory refreshed", {
        candidates: this.#candidateIds.size,
        inRadius: stations.length,
      });
    }

    const watched = stations.filter((station) =>
      this.#candidateIds.has(station.stationId)
    );

    const previous = await store.loadTrackers();
    const result = detect({
      previous,
      snapshot: watched,
      fuels: config.fuels,
      now,
      options: {
        confirmations: config.confirmations,
        cooldownMs: config.cooldownMs,
      },
    });
    await store.saveTrackers(result.next);

    for (const alert of result.alerts) {
      try {
        await notifier.send(formatAlert(alert));
        logger.info("alert delivered", {
          stationId: alert.stationId,
          fuel: alert.fuel,
          price: alert.price,
        });
      } catch (error) {
        logger.error("alert delivery failed", {
          stationId: alert.stationId,
          fuel: alert.fuel,
          error: errorMessage(error),
        });
      }
    }

    await store.saveHealth({
      lastSuccessAt: now.toISOString(),
      lastMajAt: latestMaj(watched),
      consecutiveFailures: 0,
    });
    logger.info("poll complete", {
      inRadius: stations.length,
      watched: watched.length,
      alerts: result.alerts.length,
    });
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#loop();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      try {
        await this.tick();
      } catch (error) {
        await this.#recordFailure(error);
      }
      if (!this.#running) break;

      const { pollIntervalMs, pollJitterMs } = this.deps.config;
      const jitter = (Math.random() * 2 - 1) * pollJitterMs;
      const wait = Math.max(1_000, pollIntervalMs + jitter);
      await new Promise<void>((resolve) => {
        this.#timer = setTimeout(resolve, wait);
      });
    }
  }

  async #recordFailure(error: unknown): Promise<void> {
    const { store, logger } = this.deps;
    try {
      const health = await store.loadHealth();
      await store.saveHealth({
        ...health,
        consecutiveFailures: health.consecutiveFailures + 1,
      });
    } catch (nested) {
      logger.error("failed to record poll failure", {
        error: errorMessage(nested),
      });
    }
    logger.error("poll failed", { error: errorMessage(error) });
  }
}
