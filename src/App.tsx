import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
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
import { FiChevronDown, FiChevronUp, FiNavigation, FiRefreshCw } from "react-icons/fi";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type AppFilters,
  type AppState,
  type BrandDirectory,
  FUEL_CODES,
  type FuelCode,
  type FuelState,
  type SortMode,
  type StationSnapshot,
} from "./types.ts";
import { type FilterState, loadFilters, saveFilters } from "./filters/store.ts";
import { loadCachedBrands, saveCachedBrands } from "./brands/store.ts";
import {
  fetchBrandDirectory,
  fetchResults,
  fetchState,
  pushFilters,
  refreshResults,
  requestNotificationPermission,
} from "./state/client.ts";

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

function finiteOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFuelCode(value: string | null | undefined): FuelCode | null {
  if (!value) return null;
  return (FUEL_CODES as readonly string[]).includes(value) ? (value as FuelCode) : null;
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
  const [latitude, setLatitude] = useState<number | string>(stored.latitude ?? DEFAULTS.latitude);
  const [radiusKm, setRadiusKm] = useState<number | string>(stored.radiusKm ?? DEFAULTS.radiusKm);
  const [freeText, setFreeText] = useState(stored.freeText ?? "");
  const [selectedBrands, setSelectedBrands] = useState<string[]>(
    stored.selectedBrands ? [...stored.selectedBrands] : [],
  );
  const [selectedFuel, setSelectedFuel] = useState<FuelCode | null>(
    toFuelCode(stored.selectedFuel),
  );
  const [sortBy, setSortBy] = useState<SortMode>(stored.sortBy ?? "distance");
  const [onlyAvailable, setOnlyAvailable] = useState(stored.onlyAvailable ?? false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    stored.notificationsEnabled ?? false,
  );
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [apiReady, setApiReady] = useState(false);

  const [results, setResults] = useState<StationSnapshot[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataUpdatedAt, setDataUpdatedAt] = useState<string | null>(null);
  const [lastSearchAt, setLastSearchAt] = useState<Date | null>(null);
  const [pollIntervalMs, setPollIntervalMs] = useState(REFRESH_SECONDS * 1000);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [startedAt] = useState(() => Date.now());
  const [showFilters, setShowFilters] = useState(false);
  const [applied, setApplied] = useState<AppliedFilters | null>({
    longitude: finiteOr(stored.longitude, DEFAULTS.longitude),
    latitude: finiteOr(stored.latitude, DEFAULTS.latitude),
    radiusKm: finiteOr(stored.radiusKm, DEFAULTS.radiusKm),
  });

  // Before the first server snapshot arrives, count down from mount time so the
  // timer is not frozen; once the poller reports a fetch time, use that instead.
  const countdownBase = lastSearchAt ? lastSearchAt.getTime() : startedAt;
  const countdown = Math.max(0, Math.round((countdownBase + pollIntervalMs - nowTick) / 1000));

  const [brandDirectory, setBrandDirectory] = useState<BrandDirectory>(() => loadCachedBrands());

  const brandDirectoryRef = useRef(brandDirectory);
  const initialSearchDone = useRef(false);
  const autoRefreshFiredRef = useRef(false);
  const pushReadyRef = useRef(false);

  const brands = useMemo(() => {
    const names = new Set(Object.keys(brandDirectory.brands));
    for (const brand of selectedBrands) names.add(brand);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [brandDirectory, selectedBrands]);

  function updateBrandDirectory(next: BrandDirectory) {
    brandDirectoryRef.current = next;
    setBrandDirectory(next);
  }

  function applyServerState(state: AppState) {
    const f = state.filters;
    setLongitude(f.longitude);
    setLatitude(f.latitude);
    setRadiusKm(f.radiusKm);
    setFreeText(f.freeText);
    setSelectedBrands([...f.selectedBrands]);
    setSelectedFuel(f.selectedFuel);
    setOnlyAvailable(f.onlyAvailable);
    setSortBy(f.sortBy);
    setNotificationsEnabled(f.notificationsEnabled);
    updateBrandDirectory(state.brandDirectory);
    setApplied({
      longitude: f.longitude,
      latitude: f.latitude,
      radiusKm: f.radiusKm,
    });
  }

  function handleNotificationsToggle(enabled: boolean) {
    setNotificationsEnabled(enabled);
    setNotificationError(null);
    if (!enabled || !apiReady) return;
    void requestNotificationPermission().then(({ granted, available }) => {
      if (!available) {
        setNotificationsEnabled(false);
        setNotificationError("Notifications système indisponibles dans ce mode.");
        return;
      }
      if (!granted) {
        setNotificationsEnabled(false);
        setNotificationError("Notifications refusées. Autorisez-les dans les réglages système.");
      }
    });
  }

  async function pullResults(silent = false, force = false) {
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    const serverResults = force ? await refreshResults() : await fetchResults();
    if (!serverResults) {
      if (!silent) {
        setError("Moteur indisponible.");
        setLoading(false);
      }
      return;
    }
    setResults(serverResults.stations);
    setDataUpdatedAt(serverResults.dataUpdatedAt);
    if (serverResults.pollIntervalMs > 0) {
      setPollIntervalMs(serverResults.pollIntervalMs);
    }
    const fetched = new Date(serverResults.fetchedAt);
    if (!Number.isNaN(fetched.getTime()) && fetched.getTime() > 0) {
      setLastSearchAt(fetched);
    }
    if (serverResults.error) setError(serverResults.error);
    if (!silent) setLoading(false);
  }

  useEffect(() => {
    if (initialSearchDone.current) return;
    initialSearchDone.current = true;

    void (async () => {
      const state = await fetchState();
      if (state) {
        pushReadyRef.current = true;
        applyServerState(state);
      }
      setApiReady(true);
      await pullResults(false, true);
    })();
  }, []);

  useEffect(() => {
    if (!apiReady) return;
    if (!pushReadyRef.current) {
      pushReadyRef.current = true;
      return;
    }
    const filters: AppFilters = {
      longitude: finiteOr(longitude, DEFAULTS.longitude),
      latitude: finiteOr(latitude, DEFAULTS.latitude),
      radiusKm: finiteOr(radiusKm, DEFAULTS.radiusKm),
      freeText,
      selectedBrands: [...selectedBrands],
      selectedFuel,
      onlyAvailable,
      sortBy,
      notificationsEnabled,
    };
    const timer = setTimeout(() => {
      void pushFilters(filters).then(() => pullResults(true));
      setApplied({
        longitude: filters.longitude,
        latitude: filters.latitude,
        radiusKm: filters.radiusKm,
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [
    apiReady,
    longitude,
    latitude,
    radiusKm,
    freeText,
    selectedBrands,
    selectedFuel,
    onlyAvailable,
    sortBy,
    notificationsEnabled,
  ]);

  useEffect(() => {
    if (!apiReady) return;
    const timer = setInterval(() => {
      void pullResults(true);
      void fetchBrandDirectory().then((directory) => {
        if (directory && directory.updatedAt !== brandDirectoryRef.current.updatedAt) {
          updateBrandDirectory(directory);
          saveCachedBrands(directory);
        }
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [apiReady]);

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
      notificationsEnabled,
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
    notificationsEnabled,
  ]);

  useEffect(() => {
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (countdown > 0) {
      autoRefreshFiredRef.current = false;
      return;
    }
    if (autoRefreshFiredRef.current) return;
    autoRefreshFiredRef.current = true;
    void pullResults(true, true);
  }, [countdown]);

  const visible = results;

  return (
    <Container size="md" py="xl">
      <Stack gap="lg">
        <div>
          <Title order={1}>Scan Carburant</Title>
          <Text c="dimmed" size="sm">
            Stations-service autour d'un point, d'après le flux instantané des prix des carburants
            (données publiques).
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
                    aria-label={showFilters ? "Masquer les filtres" : "Afficher les filtres"}
                    onClick={() => setShowFilters((value) => !value)}
                  >
                    {showFilters ? <FiChevronUp /> : <FiChevronDown />}
                  </ActionIcon>
                </Group>
                <Button
                  variant="light"
                  aria-label="Actualiser"
                  onClick={() => void pullResults(false, true)}
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
                Dernière récupération : {formatDateTime(lastSearchAt)} · Dernière maj station :{" "}
                {formatDateTime(dataUpdatedAt)}
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
                  placeholder={
                    brands.length > 0 ? "Toutes les marques" : "Aucune marque disponible"
                  }
                  data={brands}
                  value={selectedBrands}
                  onChange={setSelectedBrands}
                  searchable
                  clearable
                  nothingFoundMessage="Aucune marque"
                  disabled={brands.length === 0}
                />
                <TextInput
                  label="Recherche libre"
                  placeholder="ville, adresse…"
                  value={freeText}
                  onChange={(event) => setFreeText(event.currentTarget.value)}
                />
              </Group>

              <Text size="xs" c="dimmed">
                Le flux ouvert ne contient pas de champ « enseigne ». Les marques sont récupérées
                via OpenStreetMap (Overpass) et rafraîchies en arrière-plan toutes les heures par le
                moteur Rust.
              </Text>

              <Group gap="xs">
                <Text size="xs" c="dimmed">
                  Marques : {brands.length} en cache · maj{" "}
                  {formatDateTime(brandDirectory.updatedAt)}
                </Text>
              </Group>

              <Switch
                label="Me notifier quand un carburant redevient disponible"
                checked={notificationsEnabled}
                onChange={(event) => handleNotificationsToggle(event.currentTarget.checked)}
                size="xs"
              />

              {notificationError && (
                <Text size="xs" c="red">
                  {notificationError}
                </Text>
              )}

              <Text size="xs" c="dimmed">
                Surveillance en arrière-plan active : les alertes continuent même fenêtre fermée.
              </Text>
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
                  onChange={(value) => setSelectedFuel(value as FuelCode | null)}
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
                  onChange={(value) => setSortBy((value as SortMode | null) ?? "distance")}
                  allowDeselect={false}
                  size="xs"
                  w={180}
                />
                <Switch
                  label="Disponible uniquement"
                  checked={onlyAvailable}
                  onChange={(event) => setOnlyAvailable(event.currentTarget.checked)}
                  size="xs"
                />
              </Group>
            </Group>
            {visible.length === 0 && (
              <Text c="dimmed">Aucune station ne correspond aux critères.</Text>
            )}
            {visible.map((station) => (
              <Card key={station.stationId} withBorder radius="md" p="md">
                <Group gap="sm" align="flex-start" wrap="nowrap">
                  <Badge variant="light">{station.distanceKm.toFixed(1)} km</Badge>
                  <div>
                    <Group gap="xs" wrap="nowrap" align="center">
                      <Text fw={600}>{station.name}</Text>
                      {applied && (
                        <ActionIcon
                          variant="subtle"
                          color="blue"
                          size="sm"
                          aria-label={`Itinéraire vers ${station.name}`}
                          title="Itinéraire Google Maps"
                          onClick={() => {
                            void openUrl(googleMapsDirectionsUrl(applied, station));
                          }}
                        >
                          <FiNavigation size={16} />
                        </ActionIcon>
                      )}
                    </Group>
                    <Text size="sm" c="dimmed">
                      #{station.stationId} · {station.city}
                    </Text>
                  </div>
                </Group>
                <Group gap="xs" mt="sm">
                  {FUEL_CODES.map((fuel) => (
                    <FuelBadge key={fuel} fuel={fuel} state={station.fuels[fuel]} />
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

function googleMapsDirectionsUrl(
  origin: { latitude: number; longitude: number },
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
