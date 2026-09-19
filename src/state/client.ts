// Client for the Deno-side shared state API (`server.ts`).
//
// Present under `deno desktop` and `deno run server.ts`; absent under plain
// `deno task dev` (Vite only), where the app falls back to client-side polling
// and localStorage. `apiAvailable()` probes once and caches the result.

import {
  type AppFilters,
  type AppState,
  deserializeStation,
  normalizeFilters,
  type PollSnapshot,
} from "../../shared/app-state.ts";
import type { BrandDirectory } from "../../watcher/brands/directory.ts";
import type { StationSnapshot } from "../../watcher/domain/model.ts";

export interface ServerResults {
  readonly stations: StationSnapshot[];
  readonly fetchedAt: string;
  readonly dataUpdatedAt: string | null;
  readonly polling: boolean;
  readonly error: string | null;
  readonly pollIntervalMs: number;
}

let availability: boolean | null = null;

export async function apiAvailable(): Promise<boolean> {
  if (availability !== null) return availability;
  try {
    const response = await fetch("/api/state", {
      headers: { accept: "application/json" },
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("application/json")) {
      availability = false;
      return availability;
    }
    const body = await response.json() as { filters?: unknown } | null;
    availability = body !== null && typeof body === "object" &&
      body.filters !== undefined;
  } catch {
    availability = false;
  }
  return availability;
}

export async function fetchState(): Promise<AppState | null> {
  try {
    const response = await fetch("/api/state", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as AppState;
  } catch {
    return null;
  }
}

export async function pushFilters(filters: AppFilters): Promise<void> {
  try {
    await fetch("/api/state", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filters: normalizeFilters(filters) }),
    });
  } catch {
    // The poller keeps its last known filters; the next change retries.
  }
}

function toServerResults(snapshot: PollSnapshot): ServerResults {
  return {
    stations: snapshot.stations.map(deserializeStation),
    fetchedAt: snapshot.fetchedAt,
    dataUpdatedAt: snapshot.dataUpdatedAt,
    polling: snapshot.polling,
    error: snapshot.error,
    pollIntervalMs: snapshot.pollIntervalMs ?? 0,
  };
}

export async function fetchResults(): Promise<ServerResults | null> {
  try {
    const response = await fetch("/api/results", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return toServerResults((await response.json()) as PollSnapshot);
  } catch {
    return null;
  }
}

/** Force the Deno poller to poll now, then return the fresh snapshot. */
export async function refreshResults(): Promise<ServerResults | null> {
  try {
    const response = await fetch("/api/refresh", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return toServerResults((await response.json()) as PollSnapshot);
  } catch {
    return null;
  }
}

export async function fetchBrandDirectory(): Promise<BrandDirectory | null> {
  try {
    const response = await fetch("/api/brands", {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    return (await response.json()) as BrandDirectory;
  } catch {
    return null;
  }
}

export interface NotificationPermissionResult {
  readonly granted: boolean;
  readonly available: boolean;
}

export async function requestNotificationPermission(): Promise<
  NotificationPermissionResult
> {
  try {
    const response = await fetch("/api/notifications/permission", {
      method: "POST",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { granted: false, available: false };
    const body = (await response.json()) as {
      granted?: boolean;
      available?: boolean;
    };
    return {
      granted: body.granted === true,
      available: body.available === true,
    };
  } catch {
    return { granted: false, available: false };
  }
}
