import type { SelectionConfig } from "./config.ts";
import type { StationSnapshot } from "./domain/model.ts";
import type { StationFilter } from "./ports.ts";

function compile(patterns: readonly string[] | undefined): RegExp[] {
  return (patterns ?? []).map((pattern) => new RegExp(pattern, "i"));
}

export function createStationSelector(
  selection: SelectionConfig,
): StationFilter {
  const ids = selection.stationIds ? new Set(selection.stationIds) : null;
  const addressPatterns = compile(selection.addressPatterns);
  const cityPatterns = compile(selection.cityPatterns);

  if (!ids && addressPatterns.length === 0 && cityPatterns.length === 0) {
    return () => true;
  }

  return (station: StationSnapshot) => {
    if (ids?.has(station.stationId)) return true;
    if (addressPatterns.some((pattern) => pattern.test(station.address))) {
      return true;
    }
    if (cityPatterns.some((pattern) => pattern.test(station.city))) {
      return true;
    }
    return false;
  };
}
