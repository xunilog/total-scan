import { dirname } from "node:path";
import { PollLoop } from "./app/poll-loop.ts";
import { Watchdog } from "./app/watchdog.ts";
import { loadConfig, type WatcherConfig } from "./config.ts";
import { createOdsFeed } from "./feed/ods-feed.ts";
import { createBanGeocoder } from "./geocoding/ban.ts";
import { createNtfyNotifier } from "./notify/ntfy.ts";
import type { Clock, FuelFeed, Logger, Notifier, StateStore } from "./ports.ts";
import { createStationSelector } from "./selection.ts";
import { createSqliteStore } from "./state/sqlite-store.ts";
import { createConsoleLogger } from "./util/log.ts";

export interface Watcher {
  readonly pollLoop: PollLoop;
  readonly watchdog: Watchdog;
  start(): void;
  stop(): void;
}

export interface WatcherAdapters {
  readonly feed: FuelFeed;
  readonly store: StateStore;
  readonly notifier: Notifier;
}

export function createClock(): Clock {
  return { now: () => new Date() };
}

export function createWatcher(
  config: WatcherConfig,
  logger: Logger,
  adapters?: Partial<WatcherAdapters>,
): Watcher {
  const feed = adapters?.feed ?? createOdsFeed(config.ods, logger);
  const store = adapters?.store ?? createSqliteStore(config.stateFile);
  const notifier = adapters?.notifier ?? createNtfyNotifier(config.ntfy);
  const clock = createClock();
  const selector = createStationSelector(config.selection);

  const pollLoop = new PollLoop({
    config,
    feed,
    store,
    notifier,
    clock,
    logger,
    selector,
  });

  const watchdog = new Watchdog({
    store,
    notifier,
    clock,
    logger,
    staleMs: config.watchdogStaleMs,
    intervalMs: Math.min(config.watchdogStaleMs, 15 * 60 * 1000),
  });

  return {
    pollLoop,
    watchdog,
    start() {
      pollLoop.start();
      watchdog.start();
    },
    stop() {
      pollLoop.stop();
      watchdog.stop();
    },
  };
}

export async function prepareStateDir(stateFile: string): Promise<void> {
  const directory = dirname(stateFile);
  if (directory === "." || directory === "") return;
  await Deno.mkdir(directory, { recursive: true });
}

export async function runWatcher(configPath: string): Promise<void> {
  const logger = createConsoleLogger();
  const config = await loadConfig(configPath, createBanGeocoder());
  await prepareStateDir(config.stateFile);

  logger.info("watcher configured", {
    address: config.addressLabel,
    origin: config.origin,
    radiusKm: config.radiusKm,
    fuels: config.fuels,
    pollIntervalMs: config.pollIntervalMs,
    stateFile: config.stateFile,
  });

  const watcher = createWatcher(config, logger);
  watcher.start();

  await new Promise<void>((resolve) => {
    let stopped = false;
    const shutdown = () => {
      if (stopped) return;
      stopped = true;
      logger.info("shutting down");
      watcher.stop();
      resolve();
    };
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      try {
        Deno.addSignalListener(signal, shutdown);
      } catch {
        logger.warn("signal handler unavailable", { signal });
      }
    }
  });
}
