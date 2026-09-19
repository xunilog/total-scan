import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Collapse,
  Container,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import {
  FiChevronDown,
  FiChevronUp,
  FiNavigation,
  FiRefreshCw,
} from "react-icons/fi";
import {
  FUEL_CODES,
  type FuelCode,
  type FuelState,
  type StationSnapshot,
} from "../watcher/domain/model.ts";
import { filterStations } from "../watcher/domain/fuel-filter.ts";
import type { GeoPoint } from "../watcher/domain/geo.ts";
import { createOdsFeed } from "../watcher/feed/ods-feed.ts";
import {
  type BrandDirectory,
  brandNames,
  buildBrandIndex,
  stationMatchesBrands,
} from "../watcher/brands/directory.ts";
import { refreshBrandDirectory } from "../watcher/brands/overpass.ts";
import { normalizeStations } from "../watcher/ingest/normalizer.ts";
import {
  BRAND_TTL_MS,
  hasFetchedBrands,
  isBrandCacheStale,
  loadBrandArea,
  loadCachedBrands,
  saveBrandArea,
  saveCachedBrands,
} from "./brands/store.ts";
import {
  type FilterState,
  loadFilters,
  saveFilters,
  type SortMode,
} from "./filters/store.ts";

const ODS = {
  baseUrl: "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets",
  datasetId: "prix-des-carburants-en-france-flux-instantane-v2",
};

const DEFAULTS = {
  longitude: 7.687329,
  latitude: 48.579682,
  radiusKm: 10,
};

const REFRESH_SECONDS = 5 * 60;

function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

interface AppliedFilters {
  readonly longitude: number;
  readonly latitude: number;
  readonly radiusKm: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFuelCode(value: string | null | undefined): FuelCode | null {
  if (!value) return null;
  return (FUEL_CODES as readonly string[]).includes(value)
    ? (value as FuelCode)
    : null;
}

function matchesText(station: StationSnapshot, needle: string): boolean {
  const haystack = `${station.name} ${station.address} ${station.city}`
    .toLowerCase();
  return haystack.includes(needle);
}

function matchesFilters(
  station: StationSnapshot,
  brandIndex: ReadonlyMap<number, ReadonlySet<string>>,
  brands: readonly string[],
  needle: string,
): boolean {
  if (
    brands.length > 0 &&
    !stationMatchesBrands(brandIndex, station.stationId, brands)
  ) {
    return false;
  }
  if (needle && !matchesText(station, needle)) return false;
  return true;
}

function areaKey(origin: GeoPoint, radiusKm: number): string {
  return `${origin.latitude}|${origin.longitude}|${radiusKm}`;
}

function googleMapsDirectionsUrl(
  origin: GeoPoint,
  destination: { latitude: number; longitude: number },
): string {
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.latitude},${origin.longitude}`,
    destination: `${destination.latitude},${destination.longitude}`,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${params}`;
}

function latestFuelMaj(stations: readonly StationSnapshot[]): string | null {
  let latestMs: number | null = null;
  let latestIso: string | null = null;
  for (const station of stations) {
    for (const fuel of station.fuels.values()) {
      if (!fuel.updatedAt) continue;
      const parsed = Date.parse(fuel.updatedAt);
      if (Number.isNaN(parsed)) continue;
      if (latestMs === null || parsed > latestMs) {
        latestMs = parsed;
        latestIso = fuel.updatedAt;
      }
    }
  }
  return latestIso;
}

function stationFuelPrice(
  station: StationSnapshot,
  fuel: FuelCode | null,
): number | null {
  if (!fuel) return null;
  const state = station.fuels.get(fuel);
  if (!state || state.status !== "available") return null;
  return state.price;
}

function sortStations(
  stations: readonly StationSnapshot[],
  fuel: FuelCode | null,
  mode: SortMode,
): StationSnapshot[] {
  const byDistance = (a: StationSnapshot, b: StationSnapshot) =>
    a.distanceKm - b.distanceKm;
  if (mode !== "price" || !fuel) return [...stations].sort(byDistance);
  return [...stations].sort((a, b) => {
    const priceA = stationFuelPrice(a, fuel);
    const priceB = stationFuelPrice(b, fuel);
    if (priceA === null && priceB === null) return byDistance(a, b);
    if (priceA === null) return 1;
    if (priceB === null) return -1;
    return priceA - priceB;
  });
}

function formatDateTime(value: string | Date | null): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : "—";
  }
  return date.toLocaleString("fr-FR");
}

function FuelBadge({ fuel, state }: { fuel: FuelCode; state?: FuelState }) {
  if (!state || state.status === "not_offered") {
    return (
      <Badge variant="outline" color="gray">
        {fuel} —
      </Badge>
    );
  }
  if (state.status === "rupture") {
    return (
      <Badge variant="light" color="red">
        {fuel} rupture
      </Badge>
    );
  }
  return (
    <Badge variant="light" color="green">
      {fuel} {state.price?.toFixed(3)} €
    </Badge>
  );
}

export default function App() {
  const stored = useMemo(() => loadFilters(), []);
  const [longitude, setLongitude] = useState<number | string>(
    stored.longitude ?? DEFAULTS.longitude,
  );
  const [latitude, setLatitude] = useState<number | string>(
    stored.latitude ?? DEFAULTS.latitude,
  );
  const [radiusKm, setRadiusKm] = useState<number | string>(
    stored.radiusKm ?? DEFAULTS.radiusKm,
  );
  const [freeText, setFreeText] = useState(stored.freeText ?? "");
  const [selectedBrands, setSelectedBrands] = useState<string[]>(
    stored.selectedBrands ? [...stored.selectedBrands] : [],
  );
  const [selectedFuel, setSelectedFuel] = useState<FuelCode | null>(
    toFuelCode(stored.selectedFuel),
  );
  const [sortBy, setSortBy] = useState<SortMode>(
    stored.sortBy ?? "distance",
  );
  const [onlyAvailable, setOnlyAvailable] = useState(
    stored.onlyAvailable ?? false,
  );

  const [results, setResults] = useState<StationSnapshot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataUpdatedAt, setDataUpdatedAt] = useState<string | null>(null);
  const [lastSearchAt, setLastSearchAt] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_SECONDS);
  const [showFilters, setShowFilters] = useState(false);
  const [applied, setApplied] = useState<AppliedFilters | null>({
    longitude: finiteOr(stored.longitude, DEFAULTS.longitude),
    latitude: finiteOr(stored.latitude, DEFAULTS.latitude),
    radiusKm: finiteOr(stored.radiusKm, DEFAULTS.radiusKm),
  });

  const [brandDirectory, setBrandDirectory] = useState<BrandDirectory>(() =>
    loadCachedBrands()
  );
  const [brandRefreshing, setBrandRefreshing] = useState(false);
  const [brandError, setBrandError] = useState<string | null>(null);

  const brandDirectoryRef = useRef(brandDirectory);
  const brandRefreshingRef = useRef(false);
  const lastOriginRef = useRef<GeoPoint>(DEFAULTS);
  const lastRadiusRef = useRef(DEFAULTS.radiusKm);
  const lastBrandAreaRef = useRef<string | null>(loadBrandArea());
  const pendingBrandAreaRef = useRef<
    { origin: GeoPoint; radiusKm: number } | null
  >(null);
  const initialSearchDone = useRef(false);
  const lastQueryRef = useRef<string | null>(null);
  const searchSeqRef = useRef(0);
  const autoRefreshFiredRef = useRef(false);

  const brands = useMemo(() => {
    const names = new Set(brandNames(brandDirectory));
    for (const brand of selectedBrands) names.add(brand);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [brandDirectory, selectedBrands]);

  function updateBrandDirectory(next: BrandDirectory) {
    brandDirectoryRef.current = next;
    setBrandDirectory(next);
  }

  async function maybeRefreshBrands(
    origin: GeoPoint,
    radiusKm: number,
    force = false,
  ) {
    lastOriginRef.current = origin;
    lastRadiusRef.current = radiusKm;

    if (brandRefreshingRef.current) {
      pendingBrandAreaRef.current = { origin, radiusKm };
      return;
    }
    const current = brandDirectoryRef.current;
    if (!force && !isBrandCacheStale(current, Date.now())) return;

    brandRefreshingRef.current = true;
    setBrandRefreshing(true);
    setBrandError(null);
    try {
      const result = await refreshBrandDirectory(
        { origin, radiusKm, feed: createOdsFeed(ODS) },
        current,
      );
      updateBrandDirectory(result.directory);
      saveCachedBrands(result.directory);
      const area = areaKey(origin, radiusKm);
      lastBrandAreaRef.current = area;
      saveBrandArea(area);
    } catch (refreshError) {
      setBrandError(errorMessage(refreshError));
    } finally {
      brandRefreshingRef.current = false;
      setBrandRefreshing(false);
      const pending = pendingBrandAreaRef.current;
      pendingBrandAreaRef.current = null;
      if (
        pending &&
        areaKey(pending.origin, pending.radiusKm) !== lastBrandAreaRef.current
      ) {
        void maybeRefreshBrands(pending.origin, pending.radiusKm, true);
      }
    }
  }

  async function runSearch() {
    setCountdown(REFRESH_SECONDS);
    const lon = Number(longitude);
    const lat = Number(latitude);
    const radius = Number(radiusKm);

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      setError("Renseignez une longitude et une latitude valides.");
      return;
    }
    if (!Number.isFinite(radius) || radius <= 0) {
      setError("Le rayon doit être un nombre de kilomètres positif.");
      return;
    }

    lastQueryRef.current = `${lon}|${lat}|${radius}`;
    const seq = ++searchSeqRef.current;

    setLoading(true);
    setError(null);
    const origin: GeoPoint = { latitude: lat, longitude: lon };
    lastOriginRef.current = origin;
    lastRadiusRef.current = radius;

    try {
      const feed = createOdsFeed(ODS);
      const records = await feed.fetchRecords({
        origin,
        radiusKm: radius,
      });
      if (seq !== searchSeqRef.current) return;

      const stations = normalizeStations(records, origin, FUEL_CODES);
      stations.sort((a, b) => a.distanceKm - b.distanceKm);

      setResults(stations);
      setDataUpdatedAt(latestFuelMaj(stations));
      setApplied({
        longitude: lon,
        latitude: lat,
        radiusKm: radius,
      });
      setLastSearchAt(new Date());
    } catch (searchError) {
      if (seq === searchSeqRef.current) setError(errorMessage(searchError));
    } finally {
      if (seq === searchSeqRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (initialSearchDone.current) return;
    initialSearchDone.current = true;

    const lat = Number(latitude);
    const lon = Number(longitude);
    const radius = Number(radiusKm);
    const origin: GeoPoint = {
      latitude: Number.isFinite(lat) ? lat : DEFAULTS.latitude,
      longitude: Number.isFinite(lon) ? lon : DEFAULTS.longitude,
    };
    const validRadius = Number.isFinite(radius) && radius > 0
      ? radius
      : DEFAULTS.radiusKm;

    if (!hasFetchedBrands(brandDirectoryRef.current)) {
      void maybeRefreshBrands(origin, validRadius, true);
    }
    void runSearch();

    const timer = setInterval(() => {
      void maybeRefreshBrands(
        lastOriginRef.current,
        lastRadiusRef.current,
        true,
      );
    }, BRAND_TTL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const lon = Number(longitude);
    const lat = Number(latitude);
    const radius = Number(radiusKm);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (!Number.isFinite(radius) || radius <= 0) return;

    const signature = `${lon}|${lat}|${radius}`;
    if (lastQueryRef.current === signature) return;

    const timer = setTimeout(() => void runSearch(), 600);
    return () => clearTimeout(timer);
  }, [longitude, latitude, radiusKm]);

  useEffect(() => {
    if (selectedBrands.length === 0) return;
    const lon = Number(longitude);
    const lat = Number(latitude);
    const radius = Number(radiusKm);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    if (!Number.isFinite(radius) || radius <= 0) return;

    const origin: GeoPoint = { latitude: lat, longitude: lon };
    if (lastBrandAreaRef.current === areaKey(origin, radius)) return;
    void maybeRefreshBrands(origin, radius, true);
  }, [selectedBrands, longitude, latitude, radiusKm]);

  useEffect(() => {
    const state: FilterState = {
      longitude,
      latitude,
      radiusKm,
      freeText,
      selectedBrands,
      selectedFuel,
      onlyAvailable,
      sortBy,
    };
    saveFilters(state);
  }, [
    longitude,
    latitude,
    radiusKm,
    freeText,
    selectedBrands,
    selectedFuel,
    onlyAvailable,
    sortBy,
  ]);

  useEffect(() => {
    if (loading) return;
    const timer = setInterval(() => {
      setCountdown((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    if (countdown > 0) {
      autoRefreshFiredRef.current = false;
      return;
    }
    if (autoRefreshFiredRef.current) return;
    autoRefreshFiredRef.current = true;
    void runSearch();
  }, [countdown]);

  const brandIndex = useMemo(
    () => buildBrandIndex(brandDirectory),
    [brandDirectory],
  );
  const normalizedFreeText = freeText.trim().toLowerCase();

  const visible = results
    ? sortStations(
      filterStations(
        results.filter((station) =>
          matchesFilters(
            station,
            brandIndex,
            selectedBrands,
            normalizedFreeText,
          )
        ),
        selectedFuel ? [selectedFuel] : [],
        onlyAvailable,
      ),
      selectedFuel,
      sortBy,
    )
    : null;

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <div>
          <Title order={1}>Scan Carburant</Title>
          <Text c="dimmed" size="sm">
            Stations-service autour d'un point, d'après le flux instantané des
            prix des carburants (données publiques).
          </Text>
        </div>

        {applied && (
          <Paper radius="lg" p="md" withBorder>
            <Stack gap="xs">
              <Group justify="space-between" align="center">
                <Group gap="xs">
                  <Text fw={600} size="sm">
                    Filtres
                  </Text>
                  <ActionIcon
                    variant="subtle"
                    size="sm"
                    aria-label={showFilters
                      ? "Masquer les filtres"
                      : "Afficher les filtres"}
                    onClick={() => setShowFilters((value) => !value)}
                  >
                    {showFilters ? <FiChevronUp /> : <FiChevronDown />}
                  </ActionIcon>
                </Group>
                <Button
                  variant="light"
                  aria-label="Actualiser"
                  onClick={() => void runSearch()}
                  disabled={loading}
                  leftSection={loading ? undefined : <FiRefreshCw />}
                  size="sm"
                  w={110}
                >
                  {loading ? <Loader size="xs" /> : formatCountdown(countdown)}
                </Button>
              </Group>
              <Group gap="xs">
                <Badge variant="light">Lon {applied.longitude}</Badge>
                <Badge variant="light">Lat {applied.latitude}</Badge>
                <Badge variant="light">Rayon {applied.radiusKm} km</Badge>
                {selectedBrands.map((brand) => (
                  <Badge key={brand} variant="light" color="blue">
                    Marque : {brand}
                  </Badge>
                ))}
                {freeText.trim() && (
                  <Badge variant="light" color="grape">
                    Texte : {freeText.trim()}
                  </Badge>
                )}
              </Group>
              <Text size="sm" c="dimmed">
                Dernière récupération : {formatDateTime(lastSearchAt)} ·{" "}
                Dernière maj station : {formatDateTime(dataUpdatedAt)}
              </Text>
            </Stack>
          </Paper>
        )}

        <Collapse expanded={showFilters} animateOpacity>
          <Paper shadow="md" radius="lg" p="xl" withBorder>
            <Stack gap="md">
              <Group grow align="flex-end">
                <NumberInput
                  label="Longitude"
                  decimalScale={6}
                  value={longitude}
                  onChange={setLongitude}
                />
                <NumberInput
                  label="Latitude"
                  decimalScale={6}
                  value={latitude}
                  onChange={setLatitude}
                />
                <NumberInput
                  label="Rayon (km)"
                  min={0.5}
                  step={1}
                  value={radiusKm}
                  onChange={setRadiusKm}
                />
              </Group>

              <Group grow align="flex-end">
                <MultiSelect
                  label="Marque (optionnel)"
                  placeholder={brandRefreshing
                    ? "Chargement des marques…"
                    : brands.length > 0
                    ? "Toutes les marques"
                    : "Aucune marque disponible"}
                  data={brands}
                  value={selectedBrands}
                  onChange={setSelectedBrands}
                  searchable
                  clearable
                  nothingFoundMessage={brands.length === 0 && brandRefreshing
                    ? "Chargement…"
                    : "Aucune marque"}
                  disabled={brands.length === 0}
                  rightSection={brandRefreshing
                    ? <Loader size="xs" />
                    : undefined}
                />
                <TextInput
                  label="Recherche libre"
                  placeholder="ville, adresse…"
                  value={freeText}
                  onChange={(event) => setFreeText(event.currentTarget.value)}
                />
              </Group>

              <Text size="xs" c="dimmed">
                Le flux ouvert ne contient pas de champ « enseigne ». Les
                marques sont récupérées via OpenStreetMap (Overpass), mises en
                cache et rafraîchies en arrière-plan toutes les heures.
              </Text>

              <Group gap="xs">
                {brandRefreshing && <Loader size="xs" />}
                <Text size="xs" c="dimmed">
                  Marques : {brands.length} en cache · maj{" "}
                  {formatDateTime(brandDirectory.updatedAt)}
                </Text>
              </Group>

              {brandError && (
                <Text size="xs" c="red">
                  Marques indisponibles : {brandError}
                </Text>
              )}
            </Stack>
          </Paper>
        </Collapse>

        {error && (
          <Alert color="red" title="Erreur">
            {error}
          </Alert>
        )}

        {loading && !visible && (
          <Group justify="center" py="xl">
            <Loader />
          </Group>
        )}

        {visible && (
          <Stack gap="sm">
            <Group justify="space-between" align="center" wrap="nowrap">
              <Text fw={600}>
                {visible.length} station{visible.length === 1 ? "" : "s"}
              </Text>
              <Group gap="sm" wrap="nowrap">
                <Select
                  aria-label="Carburant"
                  placeholder="Tous carburants"
                  data={[...FUEL_CODES]}
                  value={selectedFuel}
                  onChange={(value) =>
                    setSelectedFuel(value as FuelCode | null)}
                  searchable
                  clearable
                  size="xs"
                  w={200}
                />
                <Select
                  aria-label="Trier par"
                  data={[
                    { value: "distance", label: "Trier par distance" },
                    {
                      value: "price",
                      label: "Trier par prix",
                      disabled: !selectedFuel,
                    },
                  ]}
                  value={sortBy}
                  onChange={(value) =>
                    setSortBy((value as SortMode | null) ?? "distance")}
                  allowDeselect={false}
                  size="xs"
                  w={180}
                />
                <Switch
                  label="Disponible uniquement"
                  checked={onlyAvailable}
                  onChange={(event) =>
                    setOnlyAvailable(event.currentTarget.checked)}
                  size="xs"
                />
              </Group>
            </Group>
            {visible.length === 0 && (
              <Text c="dimmed">
                Aucune station ne correspond aux critères.
              </Text>
            )}
            {visible.map((station) => (
              <Card key={station.stationId} withBorder radius="md" p="md">
                <Group gap="sm" align="flex-start" wrap="nowrap">
                  <Badge variant="light">
                    {station.distanceKm.toFixed(1)} km
                  </Badge>
                  <div>
                    <Group gap="xs" wrap="nowrap" align="center">
                      <Text fw={600}>{station.name}</Text>
                      {applied && (
                        <Anchor
                          href={googleMapsDirectionsUrl(applied, station)}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Itinéraire vers ${station.name}`}
                          title="Itinéraire Google Maps"
                          c="blue"
                        >
                          <FiNavigation size={16} />
                        </Anchor>
                      )}
                    </Group>
                    <Text size="sm" c="dimmed">
                      #{station.stationId} · {station.city}
                    </Text>
                  </div>
                </Group>
                <Group gap="xs" mt="sm">
                  {FUEL_CODES.map((fuel) => (
                    <FuelBadge
                      key={fuel}
                      fuel={fuel}
                      state={station.fuels.get(fuel)}
                    />
                  ))}
                </Group>
              </Card>
            ))}
          </Stack>
        )}
      </Stack>
    </Container>
  );
}
