import type {
  Availability,
  FuelCode,
  FuelState,
  StationSnapshot,
} from "../domain/model.ts";
import { type GeoPoint, haversineKm } from "../domain/geo.ts";
import type { RawStationRecord } from "./raw-record.ts";

const FUEL_FIELDS: Record<FuelCode, string> = {
  Gazole: "gazole",
  SP95: "sp95",
  E10: "e10",
  SP98: "sp98",
  E85: "e85",
  GPLc: "gplc",
};

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

const PARIS_TIME_ZONE = "Europe/Paris";

function zoneOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PARIS_TIME_ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return (asUtc - utcMs) / 60000;
}

/**
 * The ODS feed returns French station timestamps as local wall-clock time but
 * labels them UTC (e.g. "2026-09-18T18:49:25+00:00"). Reinterpret the
 * wall-clock as Europe/Paris time so the resulting instant is correct.
 */
export function normalizeFrenchTimestamp(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    value,
  );
  if (!match) return null;
  const naiveUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    match[6] ? Number(match[6]) : 0,
  );
  const offset = zoneOffsetMinutes(naiveUtc);
  return new Date(naiveUtc - offset * 60000).toISOString();
}

function timestampOrNull(value: unknown): string | null {
  const raw = stringOrNull(value);
  if (raw === null) return null;
  return normalizeFrenchTimestamp(raw) ?? raw;
}

function toNameSet(value: unknown): Set<string> {
  if (Array.isArray(value)) {
    return new Set(value.filter((v): v is string => typeof v === "string"));
  }
  if (typeof value === "string") {
    return new Set(
      value.split(";").map((part) => part.trim()).filter((part) => part !== ""),
    );
  }
  return new Set();
}

function coordinatesOf(record: RawStationRecord): GeoPoint | null {
  if (record.geom && typeof record.geom.lat === "number") {
    return { latitude: record.geom.lat, longitude: record.geom.lon };
  }
  const lat = numberOrNull(record.latitude);
  const lon = numberOrNull(record.longitude);
  if (lat === null || lon === null) return null;
  const scaled = Math.abs(lat) > 1000 || Math.abs(lon) > 1000;
  return scaled
    ? { latitude: lat / 1e5, longitude: lon / 1e5 }
    : { latitude: lat, longitude: lon };
}

function classifyFuel(
  fuel: FuelCode,
  record: RawStationRecord,
  available: ReadonlySet<string>,
  unavailable: ReadonlySet<string>,
): FuelState {
  const prefix = FUEL_FIELDS[fuel];
  const price = numberOrNull(record[`${prefix}_prix`]);
  const updatedAt = timestampOrNull(record[`${prefix}_maj`]);
  const ruptureType = stringOrNull(record[`${prefix}_rupture_type`]);
  const ruptureStart = timestampOrNull(record[`${prefix}_rupture_debut`]);

  let status: Availability;
  if (unavailable.has(fuel) || ruptureType !== null) {
    status = "rupture";
  } else if (available.has(fuel) || price !== null) {
    status = "available";
  } else {
    status = "not_offered";
  }

  if (status === "rupture") {
    return {
      status,
      price: null,
      updatedAt,
      ruptureType,
      ruptureStart,
    };
  }
  if (status === "available") {
    return {
      status,
      price,
      updatedAt,
      ruptureType: null,
      ruptureStart: null,
    };
  }
  return {
    status,
    price: null,
    updatedAt: null,
    ruptureType: null,
    ruptureStart: null,
  };
}

export function normalizeStation(
  record: RawStationRecord,
  origin: GeoPoint,
  fuels: readonly FuelCode[],
): StationSnapshot | null {
  const point = coordinatesOf(record);
  if (!point) return null;

  const available = toNameSet(record.carburants_disponibles);
  const unavailable = toNameSet(record.carburants_indisponibles);

  const fuelMap = new Map<FuelCode, FuelState>();
  for (const fuel of fuels) {
    fuelMap.set(
      fuel,
      classifyFuel(fuel, record, available, unavailable),
    );
  }

  const address = stringOrNull(record.adresse) ?? "";
  const city = stringOrNull(record.ville) ?? "";
  const name = [address, city].filter((part) => part !== "").join(", ") ||
    `Station ${record.id}`;

  return {
    stationId: record.id,
    name,
    address,
    city,
    latitude: point.latitude,
    longitude: point.longitude,
    distanceKm: haversineKm(origin, point),
    fuels: fuelMap,
  };
}

export function normalizeStations(
  records: readonly RawStationRecord[],
  origin: GeoPoint,
  fuels: readonly FuelCode[],
): StationSnapshot[] {
  const stations: StationSnapshot[] = [];
  for (const record of records) {
    const station = normalizeStation(record, origin, fuels);
    if (station) stations.push(station);
  }
  return stations;
}
