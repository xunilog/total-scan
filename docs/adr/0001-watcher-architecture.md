# ADR 0001: Total fuel availability watcher — architecture

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Yann
- **Related:** none yet

## Context

TotalEnergies caps prices in France, so its stations frequently run out of
certain fuels, and a station that is out one minute can be back the next. We
want a service that watches gaz stations around a given address within a given
km radius and alerts on the availability of a chosen fuel type.

Constraints and findings that shaped this decision:

- **Availability is self-declared by the station and lags reality.** Alerts are
  "worth a call", not a guarantee.
- **The data is already open.** France publishes it at `donnees.roulez-eco.fr`
  (`/opendata/instantane_ruptures`, refreshed every ~10 min, including stock-out
  flags), and the same feed is queryable as JSON via the ODS Explore v2.1 API on
  `data.economie.gouv.fr` (dataset
  `prix-des-carburants-en-france-flux-instantane-v2`). The API supports
  server-side filtering by geodistance and fuel. Since March 2024 the feed
  carries rupture types and rupture start dates.
- **There is no brand/enseigne field in the open data.** Verified against the v2
  schema, a sample record, and all 9804 `<pdv>` elements of the raw XML: the
  only attributes are `id`, `latitude`, `longitude`, `cp`, `pop` (A=436,
  R=9368), plus address, city, hours, services, prices and ruptures. Only 20
  free-text addresses contain "TOTAL". Brand therefore cannot be filtered
  server-side and must come from a separate source.
- **Scraping the TotalEnergies site is explicitly not the approach.** The open
  data is the supported, stable source.
- **A watcher must not depend on a desktop process.** The current repository
  contains a "Hello Desktop" Deno desktop scaffold (Vite + React + Mantine,
  packaged with `deno desktop`). Desktop processes die on logout/sleep, which is
  exactly when a fuel watcher fails silently.
- **The host question is real.** A Windows box that sleeps or reboots is a weak
  host. Off-box execution (VPS cron, scheduled CI with committed state) is more
  reliable, and a Windows Service only makes sense on an always-on machine.

## Decision

Build the watcher as a **headless, host-agnostic process** and keep the UI
optional and separate.

1. **Split concerns.** A headless watcher does poll → filter → diff → notify and
   owns no UI. The existing desktop scaffold may later become a config/status
   dashboard and tray that reads the watcher's state; it never owns polling.
2. **Defer the host/service decision.** The watcher stays free of
   Windows-specific code. Whatever runs it (Windows Service, WinSW/NSSM, VPS
   cron, scheduled CI) is decided later and only touches the composition root
   and observability.
3. **Data source is the ODS Explore v2.1 API**, filtered server-side by
   geodistance, brand, and fuel. No scraping.
4. **The edge detector is the product.** Alert only on `rupture → available`
   transitions, not on every poll.

## Data source contract

- **Geocoder:** BAN (`api-adresse.data.gouv.fr`). Resolve the configured address
  to lat/lon once at configuration time and cache it. Never in the poll loop.
- **Two-phase station set:** refresh the candidate station list (geo radius +
  station selection, see Brand below) on a slow cadence (daily), then poll only
  those station IDs on the fast cadence. Cuts payload and rate-limit risk, and
  catches new/closed stations within a day.
- **Politeness:** interval 10–15 min with jitter, `ETag` / `If-Modified-Since`,
  retry with backoff plus a circuit breaker.
- **Brand is resolved from OSM/Overpass and cached.** Brand is not a port that
  the feed provides; it is enriched separately. A `BrandDirectory` maps brand
  names to government station IDs, built by querying Overpass for `amenity=fuel`
  nodes with a `brand` tag and matching them to feed stations by proximity (<150
  m, `watcher/brands/`). It is stored as a static cache, merged across areas,
  and refreshed hourly in the background (non-blocking); the UI selects brands
  from it with a multi-select. The official `prix-carburants.gouv.fr` site does
  expose brand, but only per station page, with no bulk or CORS-enabled
  endpoint, so it is not used for refresh.

## Modules

Dependency direction points inward: the domain knows nothing about HTTP, SQLite,
or Windows.

### Layers

- **Domain (pure, no I/O)** — types and decision logic.
- **Application (orchestration)** — the poll loop; talks only through ports.
- **Adapters (I/O)** — HTTP clients, SQLite, notifiers, clock, logger.
- **Composition root** — the only host-aware module.

### Module boundaries

| Module                                  | Responsibility                                                                                                                                                                 | Depends on                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `domain/model`                          | `Station`, `FuelCode`, `FuelStatus` (`Available` / `Rupture` / `NotOffered`), `Offer`, `Snapshot`, `Alert`, `Transition`. No framework types.                                  | nothing                         |
| `domain/edge-detector`                  | Pure: `(previousState, newSnapshot) -> {transitions, nextState}`. Owns hysteresis (N confirming polls), per-station cooldown, rupture→available gating, and absent-vs-rupture. | `domain/model`                  |
| `config`                                | Load + validate config (address, radius, fuels, brand patterns, intervals, thresholds, notifier refs). Resolve secret references, never inline secrets.                        | nothing                         |
| `ports`                                 | Interfaces: `Geocoder`, `StationDirectory`, `FuelFeed`, `StateStore`, `Notifier`, `Clock`, `Logger`.                                                                           | `domain/model`                  |
| `geocoding/ban-adapter`                 | `ports.Geocoder` via BAN. One-shot, cached in config.                                                                                                                          | `ports`                         |
| `directory/ods-adapter`                 | `ports.StationDirectory`: refresh candidate station IDs from geo radius + loose brand match. Slow cadence.                                                                     | `ports`                         |
| `selection`                             | Pure `StationFilter`: explicit station IDs + address/city regexes from config. The seam where OSM/Overpass brand enrichment will plug in.                                      | `domain/model`, `ports`         |
| `feed/ods-adapter`                      | `ports.FuelFeed`: fetch offers for the candidate IDs / geo filter. ETag/`If-Modified-Since`, retry + circuit breaker. Returns raw DTOs.                                        | `ports`                         |
| `ingest/normalizer`                     | Maps raw DTOs → domain `Snapshot`. Absorbs inconsistent `enseigne` strings, fuel code aliases, rupture fields, missing rows. Feed quirks are quarantined here.                 | `domain/model`                  |
| `state/sqlite-store`                    | `ports.StateStore`: load/save keyed `(station_id, fuel)`; also the feed-health record (last successful fetch, last observed `maj`).                                            | `ports`                         |
| `notify/ntfy-adapter` (+ telegram/smtp) | `ports.Notifier`: `Alert` → delivery, with an idempotency key mirroring the cooldown.                                                                                          | `ports`                         |
| `app/poll-loop`                         | Orchestrator: directory refresh cadence, then `feed → normalize → detect → store → notify`. Owns jitter and shutdown.                                                          | `domain/edge-detector`, `ports` |
| `app/watchdog`                          | Independent of the loop: flags feed silence (>~1h) or `maj` not advancing, emits a health alert.                                                                               | `ports`                         |
| `observability`                         | `Logger` adapter (rolling file + Event Log when on Windows). Injected, never imported globally.                                                                                | `ports`                         |
| `composition-root`                      | Reads config, constructs adapters, wires the loop and watchdog, starts them. The only host-aware file.                                                                         | everything                      |

### Ports (the seams)

`Geocoder`, `StationDirectory`, `FuelFeed`, `StateStore`, `Notifier`, `Clock`,
`Logger`.

- `Clock` as a port is what makes hysteresis and cooldown testable.
- `StateStore` and `Notifier` as ports let us swap SQLite for a repo file and
  ntfy for Telegram without touching the detector.

### Data flow

1. `composition-root` → `config` → construct adapters.
2. Geocode once (cached); `directory` resolves candidate IDs daily.
3. Each tick: `feed` fetch → `normalizer` → `edge-detector` against state from
   `sqlite-store` → persist `nextState` → `notifier` on transitions.
4. `watchdog` runs on its own timer and only reads feed-health state.

### Edge detector rules

- Alert only on `rupture → available` transitions.
- Hysteresis: require N (2) consecutive confirming polls before firing.
- Per-station cooldown (~6h).
- Distinguish **absent from the row** (not offered) from **rupture** (offered
  but out) — they are different events.
- Latch: a station that was out, came back, then goes out again may re-fire, but
  transient flapping must not.

### State

- SQLite keyed `(station_id, fuel)`: status, price, `carburant_maj`, rupture
  type
  - start date, `last_notified_at`, consecutive-confirm counter.
- Separately persist the last successful feed timestamp and last observed `maj`
  for the watchdog.

### Notification payload

Station name, distance, fuel, price, and the station-declared `maj` timestamp
(so freshness is judgeable), plus a "worth calling, not guaranteed" note.

### Observability

- Structured logs to rolling file, and to the Windows Event Log when running
  there.
- Staleness watchdog independent of the poll loop: alert on feed silence or
  non-advancing `maj`. Silent staleness is the top risk, not crashes.
- Secrets (ntfy topic / bot token) live in Windows Credential Manager / DPAPI or
  env — never committed.

## Testing seams

- `domain/edge-detector`: table-driven tests replaying recorded snapshots; fake
  `Clock`. Most test effort goes here.
- `ingest/normalizer`: fixture DTOs, including messy `enseigne` and missing-fuel
  rows.
- `app/poll-loop`: fake ports to assert order, dedup, and shutdown.
- Adapters: thin, covered by a few contract/integration tests against recorded
  HTTP and a temp SQLite file.

## Rules that keep it clean

- `edge-detector` and `normalizer` import no I/O and no host APIs.
- Adapters depend on ports; ports depend only on the domain.
- No module reaches around the loop to write state or send alerts directly.
- The Windows service question only ever touches `composition-root` and
  `observability`.

## Consequences

- The watcher can be developed and tested locally with no host decision, then
  deployed off-box first.
- Two deployables eventually (watcher + optional dashboard), which is more
  moving parts than a single desktop app but far more reliable.
- Choosing the implementation stack (.NET Worker Service vs Deno + WinSW/NSSM)
  and the host (Windows box vs VPS/CI) remains open.

## Deferred decisions / open questions

- **Host:** Windows Service vs WinSW/NSSM wrapper vs off-box (VPS cron /
  scheduled CI with committed state).
- **Brand source:** decided — OSM/Overpass `brand` tags matched to feed station
  IDs by proximity, cached and refreshed hourly (see Brand above). Fallback if
  Overpass coverage is poor: an explicit station-ID list.
- **Implementation stack:** a second .NET stack for native service semantics, or
  a single Deno codebase wrapped as a service.
- **Alert transport:** ntfy vs Telegram (both free and easy).
- **Fuel codes to watch by default** and default radius.
- Whether the existing Deno desktop scaffold becomes the dashboard or is
  discarded/renamed.
