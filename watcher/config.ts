import { FUEL_CODES, type FuelCode } from "./domain/model.ts";
import type { GeoPoint } from "./domain/geo.ts";
import type { Geocoder } from "./ports.ts";

export interface SelectionConfig {
  readonly stationIds?: readonly number[];
  readonly addressPatterns?: readonly string[];
  readonly cityPatterns?: readonly string[];
}

export interface NtfyConfig {
  readonly server: string;
  readonly topic: string;
  readonly token?: string;
}

export interface OdsConfig {
  readonly baseUrl: string;
  readonly datasetId: string;
}

export interface ConfigFile {
  readonly address?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly radiusKm: number;
  readonly fuels?: readonly FuelCode[];
  readonly selection?: SelectionConfig;
  readonly pollIntervalMs?: number;
  readonly pollJitterMs?: number;
  readonly confirmations?: number;
  readonly cooldownMs?: number;
  readonly directoryRefreshMs?: number;
  readonly stateFile: string;
  readonly ntfy: NtfyConfig;
  readonly watchdogStaleMs?: number;
  readonly ods?: Partial<OdsConfig>;
}

export interface WatcherConfig {
  readonly origin: GeoPoint;
  readonly addressLabel: string;
  readonly radiusKm: number;
  readonly fuels: readonly FuelCode[];
  readonly selection: SelectionConfig;
  readonly pollIntervalMs: number;
  readonly pollJitterMs: number;
  readonly confirmations: number;
  readonly cooldownMs: number;
  readonly directoryRefreshMs: number;
  readonly stateFile: string;
  readonly ntfy: NtfyConfig;
  readonly watchdogStaleMs: number;
  readonly ods: OdsConfig;
}

const DEFAULTS = {
  fuels: FUEL_CODES,
  pollIntervalMs: 15 * 60 * 1000,
  pollJitterMs: 60 * 1000,
  confirmations: 2,
  cooldownMs: 6 * 60 * 60 * 1000,
  directoryRefreshMs: 24 * 60 * 60 * 1000,
  watchdogStaleMs: 60 * 60 * 1000,
} as const;

const DEFAULT_ODS: OdsConfig = {
  baseUrl: "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets",
  datasetId: "prix-des-carburants-en-france-flux-instantane-v2",
};

const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

function fail(message: string): never {
  throw new Error(`Invalid config: ${message}`);
}

function assertPositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${field} must be a positive number`);
  }
}

function parseFuels(
  input: readonly FuelCode[] | undefined,
): readonly FuelCode[] {
  if (input === undefined) return DEFAULTS.fuels;
  if (input.length === 0) fail("fuels must contain at least one fuel");
  for (const fuel of input) {
    if (!FUEL_CODES.includes(fuel)) {
      fail(`unknown fuel "${fuel}"`);
    }
  }
  return [...input];
}

function resolveOrigin(
  file: ConfigFile,
  geocoded: GeoPoint | null,
): GeoPoint {
  if (geocoded) return geocoded;
  if (typeof file.latitude === "number" && typeof file.longitude === "number") {
    return { latitude: file.latitude, longitude: file.longitude };
  }
  fail("provide latitude/longitude or an address that can be geocoded");
}

export async function loadConfig(
  path: string,
  geocoder: Geocoder,
): Promise<WatcherConfig> {
  const raw = await Deno.readTextFile(path);
  const file = JSON.parse(raw) as ConfigFile;

  if (typeof file !== "object" || file === null) {
    fail("config must be an object");
  }
  if (typeof file.radiusKm !== "number") fail("radiusKm is required");
  assertPositive(file.radiusKm, "radiusKm");
  if (typeof file.stateFile !== "string" || file.stateFile === "") {
    fail("stateFile is required");
  }
  if (
    !file.ntfy || typeof file.ntfy.topic !== "string" || file.ntfy.topic === ""
  ) {
    fail("ntfy.topic is required");
  }

  const pollIntervalMs = file.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const pollJitterMs = file.pollJitterMs ?? DEFAULTS.pollJitterMs;
  assertPositive(pollIntervalMs, "pollIntervalMs");
  if (pollJitterMs < 0) fail("pollJitterMs must be >= 0");

  const confirmations = file.confirmations ?? DEFAULTS.confirmations;
  if (!Number.isInteger(confirmations) || confirmations < 1) {
    fail("confirmations must be an integer >= 1");
  }

  const cooldownMs = file.cooldownMs ?? DEFAULTS.cooldownMs;
  if (cooldownMs < 0) fail("cooldownMs must be >= 0");

  const directoryRefreshMs = file.directoryRefreshMs ??
    DEFAULTS.directoryRefreshMs;
  assertPositive(directoryRefreshMs, "directoryRefreshMs");

  const watchdogStaleMs = file.watchdogStaleMs ?? DEFAULTS.watchdogStaleMs;
  assertPositive(watchdogStaleMs, "watchdogStaleMs");

  let geocoded: GeoPoint | null = null;
  let addressLabel = file.address ?? "";
  const hasCoordinates = typeof file.latitude === "number" &&
    typeof file.longitude === "number";
  if (!hasCoordinates) {
    if (!file.address || file.address.trim() === "") {
      fail("provide latitude/longitude or address");
    }
    const result = await geocoder.geocode(file.address);
    geocoded = { latitude: result.latitude, longitude: result.longitude };
    addressLabel = result.label;
  }

  const token = file.ntfy.token ?? Deno.env.get("NTFY_TOKEN") ?? undefined;

  return {
    origin: resolveOrigin(file, geocoded),
    addressLabel,
    radiusKm: file.radiusKm,
    fuels: parseFuels(file.fuels),
    selection: file.selection ?? {},
    pollIntervalMs,
    pollJitterMs,
    confirmations,
    cooldownMs,
    directoryRefreshMs,
    stateFile: file.stateFile,
    ntfy: {
      server: file.ntfy.server ?? DEFAULT_NTFY_SERVER,
      topic: file.ntfy.topic,
      token,
    },
    watchdogStaleMs,
    ods: { ...DEFAULT_ODS, ...file.ods },
  };
}
