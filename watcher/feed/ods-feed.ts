import type { OdsConfig } from "../config.ts";
import { CircuitBreaker, DEFAULT_RETRY, fetchWithRetry } from "../http.ts";
import type { RawStationRecord } from "../ingest/raw-record.ts";
import type { FeedQuery, FuelFeed, Logger } from "../ports.ts";

const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const FUEL_PREFIXES = ["gazole", "sp95", "e10", "sp98", "e85", "gplc"];

const SELECT_FIELDS = [
  "id",
  "geom",
  "latitude",
  "longitude",
  "adresse",
  "ville",
  "cp",
  "carburants_disponibles",
  "carburants_indisponibles",
  ...FUEL_PREFIXES.flatMap((prefix) => [
    `${prefix}_prix`,
    `${prefix}_maj`,
    `${prefix}_rupture_type`,
    `${prefix}_rupture_debut`,
  ]),
].join(",");

interface OdsPage {
  readonly total_count: number;
  readonly results: RawStationRecord[];
}

export function createOdsFeed(config: OdsConfig, logger?: Logger): FuelFeed {
  const breaker = new CircuitBreaker(5, 5 * 60 * 1000);

  async function fetchPage(url: URL): Promise<OdsPage> {
    const response = await breaker.execute(() =>
      fetchWithRetry(
        url,
        {
          headers: { accept: "application/json" },
          cache: "no-store",
        },
        { ...DEFAULT_RETRY, maxAttempts: 4 },
      )
    );
    if (!response.ok) {
      throw new Error(`ODS feed responded with status ${response.status}`);
    }
    return (await response.json()) as OdsPage;
  }

  return {
    async fetchRecords(query: FeedQuery): Promise<RawStationRecord[]> {
      const where =
        `within_distance(geom, geom'POINT(${query.origin.longitude} ${query.origin.latitude})', ${query.radiusKm}km)`;
      const records: RawStationRecord[] = [];

      for (let page = 0; page < MAX_PAGES; page++) {
        const url = new URL(`${config.baseUrl}/${config.datasetId}/records`);
        url.searchParams.set("where", where);
        url.searchParams.set("select", SELECT_FIELDS);
        url.searchParams.set("limit", String(PAGE_SIZE));
        url.searchParams.set("offset", String(page * PAGE_SIZE));

        const body = await fetchPage(url);
        if (!Array.isArray(body.results)) {
          throw new Error("ODS feed returned an unexpected payload");
        }
        records.push(...body.results);

        logger?.info("ods page fetched", {
          page,
          received: body.results.length,
          total: body.total_count,
        });

        if (
          body.results.length < PAGE_SIZE ||
          records.length >= body.total_count
        ) {
          break;
        }
      }

      return records;
    },
  };
}
