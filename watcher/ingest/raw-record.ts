export interface RawStationRecord {
  readonly id: number;
  readonly geom?: { readonly lon: number; readonly lat: number } | null;
  readonly latitude?: string | number | null;
  readonly longitude?: string | number | null;
  readonly adresse?: string | null;
  readonly ville?: string | null;
  readonly cp?: string | null;
  readonly [field: string]: unknown;
}
