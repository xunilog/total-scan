// Tauri command client.
//
// The Rust core owns polling, filtering, sorting, and persistence. The UI only
// calls these wrappers, which are thin typed shims over `invoke`.

import { invoke } from "@tauri-apps/api/core";
import type { AppFilters, AppState, BrandDirectory, PollSnapshot } from "../types.ts";

export interface ServerResults {
  readonly stations: PollSnapshot["stations"];
  readonly fetchedAt: string;
  readonly dataUpdatedAt: string | null;
  readonly polling: boolean;
  readonly error: string | null;
  readonly pollIntervalMs: number;
}

function toServerResults(snapshot: PollSnapshot): ServerResults {
  return {
    stations: snapshot.stations ?? [],
    fetchedAt: snapshot.fetchedAt,
    dataUpdatedAt: snapshot.dataUpdatedAt,
    polling: snapshot.polling,
    error: snapshot.error,
    pollIntervalMs: snapshot.pollIntervalMs ?? 0,
  };
}

export async function fetchState(): Promise<AppState | null> {
  try {
    return await invoke<AppState>("get_state");
  } catch {
    return null;
  }
}

export async function pushFilters(filters: AppFilters): Promise<void> {
  try {
    await invoke("update_filters", { filters });
  } catch {
    // The poller keeps its last known filters; the next change retries.
  }
}

export async function fetchResults(): Promise<ServerResults | null> {
  try {
    return toServerResults(await invoke<PollSnapshot>("get_results"));
  } catch {
    return null;
  }
}

/** Force the Rust poller to poll now, then return the fresh snapshot. */
export async function refreshResults(): Promise<ServerResults | null> {
  try {
    return toServerResults(await invoke<PollSnapshot>("refresh"));
  } catch {
    return null;
  }
}

export async function fetchBrandDirectory(): Promise<BrandDirectory | null> {
  try {
    return await invoke<BrandDirectory>("get_brands");
  } catch {
    return null;
  }
}

export interface NotificationPermissionResult {
  readonly granted: boolean;
  readonly available: boolean;
}

export async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  try {
    const body = await invoke<{ granted?: boolean; available?: boolean }>(
      "notification_permission",
    );
    return {
      granted: body.granted === true,
      available: body.available === true,
    };
  } catch {
    return { granted: false, available: false };
  }
}
