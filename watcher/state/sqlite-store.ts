import { DatabaseSync } from "node:sqlite";
import type { Availability, FuelTrackerState } from "../domain/model.ts";
import type { FeedHealth, StateStore } from "../ports.ts";

interface TrackerRow {
  key: string;
  status: string;
  candidate: string;
  confirmations: number;
  price: number | null;
  updated_at: string | null;
  rupture_type: string | null;
  rupture_start: string | null;
  last_notified_at: string | null;
}

interface HealthRow {
  last_success_at: string | null;
  last_maj_at: string | null;
  consecutive_failures: number;
}

export function createSqliteStore(path: string): StateStore {
  const db = new DatabaseSync(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS trackers (
      key TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      candidate TEXT NOT NULL,
      confirmations INTEGER NOT NULL,
      price REAL,
      updated_at TEXT,
      rupture_type TEXT,
      rupture_start TEXT,
      last_notified_at TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS feed_health (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_success_at TEXT,
      last_maj_at TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0
    )
  `);

  const selectTrackers = db.prepare("SELECT * FROM trackers");
  const deleteTrackers = db.prepare("DELETE FROM trackers");
  const insertTracker = db.prepare(`
    INSERT INTO trackers (
      key, status, candidate, confirmations, price,
      updated_at, rupture_type, rupture_start, last_notified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectHealth = db.prepare(
    "SELECT last_success_at, last_maj_at, consecutive_failures FROM feed_health WHERE id = 1",
  );
  const upsertHealth = db.prepare(`
    INSERT INTO feed_health (id, last_success_at, last_maj_at, consecutive_failures)
    VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_success_at = excluded.last_success_at,
      last_maj_at = excluded.last_maj_at,
      consecutive_failures = excluded.consecutive_failures
  `);

  return {
    loadTrackers(): Promise<Map<string, FuelTrackerState>> {
      const trackers = new Map<string, FuelTrackerState>();
      for (const row of selectTrackers.all() as unknown as TrackerRow[]) {
        trackers.set(row.key, {
          status: row.status as Availability,
          candidate: row.candidate as Availability,
          confirmations: row.confirmations,
          price: row.price,
          updatedAt: row.updated_at,
          ruptureType: row.rupture_type,
          ruptureStart: row.rupture_start,
          lastNotifiedAt: row.last_notified_at,
        });
      }
      return Promise.resolve(trackers);
    },

    saveTrackers(
      trackers: ReadonlyMap<string, FuelTrackerState>,
    ): Promise<void> {
      db.exec("BEGIN");
      try {
        deleteTrackers.run();
        for (const [key, tracker] of trackers) {
          insertTracker.run(
            key,
            tracker.status,
            tracker.candidate,
            tracker.confirmations,
            tracker.price,
            tracker.updatedAt,
            tracker.ruptureType,
            tracker.ruptureStart,
            tracker.lastNotifiedAt,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return Promise.resolve();
    },

    loadHealth(): Promise<FeedHealth> {
      const row = selectHealth.get() as unknown as HealthRow | undefined;
      return Promise.resolve({
        lastSuccessAt: row?.last_success_at ?? null,
        lastMajAt: row?.last_maj_at ?? null,
        consecutiveFailures: row?.consecutive_failures ?? 0,
      });
    },

    saveHealth(health: FeedHealth): Promise<void> {
      upsertHealth.run(
        health.lastSuccessAt,
        health.lastMajAt,
        health.consecutiveFailures,
      );
      return Promise.resolve();
    },
  };
}
