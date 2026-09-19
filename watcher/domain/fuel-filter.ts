import type { FuelCode, StationSnapshot } from "./model.ts";

export function offersFuel(
  station: StationSnapshot,
  fuels: readonly FuelCode[],
): boolean {
  if (fuels.length === 0) return true;
  return fuels.some((fuel) => {
    const state = station.fuels.get(fuel);
    return state !== undefined && state.status !== "not_offered";
  });
}

export function hasAvailableFuel(
  station: StationSnapshot,
  fuels: readonly FuelCode[],
): boolean {
  if (fuels.length === 0) {
    for (const state of station.fuels.values()) {
      if (state.status === "available") return true;
    }
    return false;
  }
  return fuels.some((fuel) => station.fuels.get(fuel)?.status === "available");
}

export function filterStations(
  stations: readonly StationSnapshot[],
  selectedFuels: readonly FuelCode[],
  onlyAvailable: boolean,
): StationSnapshot[] {
  return stations.filter((station) => {
    if (onlyAvailable) return hasAvailableFuel(station, selectedFuels);
    return offersFuel(station, selectedFuels);
  });
}
