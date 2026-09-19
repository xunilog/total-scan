import type { Geocoder, GeocodeResult } from "../ports.ts";

const BAN_ENDPOINT = "https://api-adresse.data.gouv.fr/search/";

interface BanFeature {
  readonly geometry: { readonly coordinates: readonly [number, number] };
  readonly properties: { readonly label: string };
}

interface BanResponse {
  readonly features: readonly BanFeature[];
}

export function createBanGeocoder(): Geocoder {
  return {
    async geocode(address: string): Promise<GeocodeResult> {
      const url = new URL(BAN_ENDPOINT);
      url.searchParams.set("q", address);
      url.searchParams.set("limit", "1");

      const response = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`BAN geocoding failed with status ${response.status}`);
      }

      const data = (await response.json()) as BanResponse;
      const feature = data.features[0];
      if (!feature) {
        throw new Error(`No geocoding result for "${address}"`);
      }

      const [longitude, latitude] = feature.geometry.coordinates;
      return { latitude, longitude, label: feature.properties.label };
    },
  };
}
