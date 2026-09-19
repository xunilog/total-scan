import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./state/client.ts", () => ({
  fetchState: vi.fn(),
  fetchResults: vi.fn(),
  refreshResults: vi.fn(),
  pushFilters: vi.fn(),
  fetchBrandDirectory: vi.fn(),
  requestNotificationPermission: vi.fn(),
}));

import App from "./App.tsx";
import type { AppState, BrandDirectory, StationSnapshot } from "./types.ts";
import {
  fetchBrandDirectory,
  fetchResults,
  fetchState,
  pushFilters,
  refreshResults,
} from "./state/client.ts";

const BRAND_DIRECTORY: BrandDirectory = {
  updatedAt: "2026-01-01T00:00:00.000Z",
  brands: {},
};

const STATE: AppState = {
  version: 1,
  filters: {
    longitude: 2,
    latitude: 48,
    radiusKm: 10,
    freeText: "",
    selectedBrands: [],
    selectedFuel: null,
    onlyAvailable: false,
    sortBy: "distance",
    notificationsEnabled: false,
  },
  brandDirectory: BRAND_DIRECTORY,
  brandArea: null,
  trackers: {},
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const STATION: StationSnapshot = {
  stationId: 1,
  name: "Total, Sens",
  address: "1 rue",
  city: "Sens",
  latitude: 48.18,
  longitude: 3.3,
  distanceKm: 1.2,
  fuels: {
    Gazole: {
      status: "available",
      price: 1.789,
      updatedAt: null,
      ruptureType: null,
      ruptureStart: null,
    },
  },
};

const SERVER_RESULTS = {
  stations: [STATION],
  fetchedAt: "2026-01-01T00:00:00.000Z",
  dataUpdatedAt: null,
  polling: false,
  error: null,
  pollIntervalMs: 300_000,
};

beforeEach(() => {
  localStorage.clear();
  vi.mocked(fetchState).mockResolvedValue(STATE);
  vi.mocked(fetchResults).mockResolvedValue(SERVER_RESULTS);
  vi.mocked(refreshResults).mockResolvedValue(SERVER_RESULTS);
  vi.mocked(fetchBrandDirectory).mockResolvedValue(BRAND_DIRECTORY);
  vi.mocked(pushFilters).mockResolvedValue(undefined);
});

describe("App", () => {
  it("renders stations returned by the Rust core", async () => {
    render(
      <MantineProvider>
        <App />
      </MantineProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("Total, Sens")).toBeTruthy();
    });
    expect(screen.getByText(/1 station/)).toBeTruthy();
  });
});
