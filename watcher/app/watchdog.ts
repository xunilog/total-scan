import type { Clock, Logger, Notifier, StateStore } from "../ports.ts";

export interface WatchdogDeps {
  readonly store: StateStore;
  readonly notifier: Notifier;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly staleMs: number;
  readonly intervalMs: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Watchdog {
  #running = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastAlertAt = 0;

  constructor(private readonly deps: WatchdogDeps) {}

  async check(): Promise<void> {
    const { store, notifier, clock, logger, staleMs } = this.deps;
    const health = await store.loadHealth();
    if (!health.lastSuccessAt) {
      logger.warn("watchdog has no successful poll on record");
      return;
    }

    const nowMs = clock.now().getTime();
    const ageMs = nowMs - Date.parse(health.lastSuccessAt);
    if (ageMs <= staleMs) return;
    if (nowMs - this.#lastAlertAt < staleMs) return;

    const minutes = Math.round(ageMs / 60_000);
    try {
      await notifier.send({
        title: "Scan Carburant : flux silencieux",
        body:
          `Aucun poll reussi depuis ${minutes} min. Le flux est peut-etre indisponible.`,
        priority: "urgent",
        tags: ["warning"],
      });
      this.#lastAlertAt = nowMs;
    } catch (error) {
      logger.error("watchdog alert failed", { error: errorMessage(error) });
    }
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
        await this.check();
      } catch (error) {
        this.deps.logger.error("watchdog check failed", {
          error: errorMessage(error),
        });
      }
      if (!this.#running) break;
      await new Promise<void>((resolve) => {
        this.#timer = setTimeout(resolve, this.deps.intervalMs);
      });
    }
  }
}
