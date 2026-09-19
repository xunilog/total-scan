import type {
  FuelCode,
  FuelTrackerState,
  StationSnapshot,
} from "./domain/model.ts";
import type { GeoPoint } from "./domain/geo.ts";
import type { RawStationRecord } from "./ingest/raw-record.ts";

export interface GeocodeResult extends GeoPoint {
  readonly label: string;
}

export interface Geocoder {
  geocode(address: string): Promise<GeocodeResult>;
}

export interface FeedQuery {
  readonly origin: GeoPoint;
  readonly radiusKm: number;
}

export interface FuelFeed {
  fetchRecords(query: FeedQuery): Promise<RawStationRecord[]>;
}

export interface FeedHealth {
  readonly lastSuccessAt: string | null;
  readonly lastMajAt: string | null;
  readonly consecutiveFailures: number;
}

export interface StateStore {
  loadTrackers(): Promise<Map<string, FuelTrackerState>>;
  saveTrackers(trackers: ReadonlyMap<string, FuelTrackerState>): Promise<void>;
  loadHealth(): Promise<FeedHealth>;
  saveHealth(health: FeedHealth): Promise<void>;
}

export interface AlertMessage {
  readonly title: string;
  readonly body: string;
  readonly priority?: "min" | "low" | "default" | "high" | "urgent";
  readonly tags?: readonly string[];
}

export interface Notifier {
  send(message: AlertMessage): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type StationFilter = (station: StationSnapshot) => boolean;

export type FuelSelection = readonly FuelCode[];
