import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { AppFilters, PollSnapshot } from "../types.ts";
import {
  fetchBrandDirectory,
  fetchResults,
  fetchState,
  pushFilters,
  refreshResults,
  requestNotificationPermission,
} from "./client.ts";

const mockInvoke = vi.mocked(invoke);

const FILTERS: AppFilters = {
  longitude: 7.6,
  latitude: 48.5,
  radiusKm: 10,
  freeText: "",
  selectedBrands: [],
  selectedFuel: null,
  onlyAvailable: false,
  sortBy: "distance",
  notificationsEnabled: false,
};

const SNAPSHOT: PollSnapshot = {
  stations: [],
  fetchedAt: "2026-01-01T00:00:00.000Z",
  dataUpdatedAt: null,
  polling: false,
  error: null,
  pollIntervalMs: 300_000,
};

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("tauri command client", () => {
  it("fetchState invokes get_state", async () => {
    mockInvoke.mockResolvedValueOnce({ version: 1 } as never);
    await expect(fetchState()).resolves.toEqual({ version: 1 });
    expect(mockInvoke).toHaveBeenCalledWith("get_state");
  });

  it("fetchState returns null when the command fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("no core"));
    await expect(fetchState()).resolves.toBeNull();
  });

  it("pushFilters sends the filters to update_filters", async () => {
    mockInvoke.mockResolvedValueOnce(undefined as never);
    await pushFilters(FILTERS);
    expect(mockInvoke).toHaveBeenCalledWith("update_filters", {
      filters: FILTERS,
    });
  });

  it("pushFilters swallows failures", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("no core"));
    await expect(pushFilters(FILTERS)).resolves.toBeUndefined();
  });

  it("fetchResults maps a poll snapshot", async () => {
    mockInvoke.mockResolvedValueOnce(SNAPSHOT);
    await expect(fetchResults()).resolves.toEqual({
      stations: [],
      fetchedAt: "2026-01-01T00:00:00.000Z",
      dataUpdatedAt: null,
      polling: false,
      error: null,
      pollIntervalMs: 300_000,
    });
    expect(mockInvoke).toHaveBeenCalledWith("get_results");
  });

  it("fetchResults returns null when the command fails", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("no core"));
    await expect(fetchResults()).resolves.toBeNull();
  });

  it("refreshResults invokes refresh", async () => {
    mockInvoke.mockResolvedValueOnce(SNAPSHOT);
    await expect(refreshResults()).resolves.not.toBeNull();
    expect(mockInvoke).toHaveBeenCalledWith("refresh");
  });

  it("fetchBrandDirectory returns the directory", async () => {
    const directory = { updatedAt: "2026-01-01T00:00:00.000Z", brands: {} };
    mockInvoke.mockResolvedValueOnce(directory);
    await expect(fetchBrandDirectory()).resolves.toEqual(directory);
    expect(mockInvoke).toHaveBeenCalledWith("get_brands");
  });

  it("requestNotificationPermission normalizes the payload", async () => {
    mockInvoke.mockResolvedValueOnce({ granted: true, available: true });
    await expect(requestNotificationPermission()).resolves.toEqual({
      granted: true,
      available: true,
    });
    expect(mockInvoke).toHaveBeenCalledWith("notification_permission");
  });

  it("requestNotificationPermission defaults to denied on failure", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("no core"));
    await expect(requestNotificationPermission()).resolves.toEqual({
      granted: false,
      available: false,
    });
  });
});
