# ADR 0002: Migrate the desktop app from `deno desktop` to Tauri v2

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Yann
- **Related:** [ADR 0001](./0001-watcher-architecture.md) (watcher architecture)

## Context

The repository currently ships a desktop app built with Vite + React + Mantine
and packaged by `deno desktop` (Deno 2.9+). The Deno process is also the
application backend: it owns the poll loop (`poller.ts`), the shared state
(`state-store.ts`), the JSON API (`api.ts`), the native window / menu / tray
(`desktop.ts`), and OS notifications (`notify.ts`). The release workflow runs
`deno desktop` to produce a `.dmg` and an `.msi`.

Constraints carried over from ADR 0001:

- Polling must keep running with no window open (tray-only operation).
- The watcher must not depend on a webview or on a visible desktop window.
- The edge detector is the product; the `rupture → available` logic and its
  tests are the most valuable code in the tree.

Goals of this migration:

- Move to the latest stable Tauri (v2, currently 2.11.x).
- Remove the Deno runtime and the `deno desktop` toolchain.
- Stay lightweight: no sidecar, no second runtime, no bundled Chromium.
- Keep the existing UI (React + Mantine) and the existing behavior.

Options considered:

1. **Deno sidecar inside Tauri.** Compile `watcher/` + `poller.ts` with
   `deno compile` and ship it as a Tauri `externalBin`, letting Rust own the
   tray, notifications, and state. Preserves all TypeScript and its tests, but
   adds ~90 MB per platform, needs per-target cross-compilation, and keeps two
   runtimes. Rejected: contradicts the "super lightweight" goal.
2. **Poller in the webview (TypeScript).** Keep the TS domain logic running in
   the Tauri webview. Smallest change, but a hidden/backgrounded webview can be
   throttled or suspended, which silently breaks tray-only polling. Rejected:
   violates ADR 0001 and is unreliable.
3. **Rust core + JS UI (chosen).** Port the backend to Rust; keep the frontend
   as TypeScript built with npm/Vite. Single small binary, no Deno, no sidecar.

## Decision

Adopt **Tauri v2 with a Rust core and a TypeScript/JavaScript UI**. There is no
Deno runtime, no sidecar, and no bundled browser engine (system webview:
WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux).

### Ownership split

**Rust core (`src-tauri/`) owns everything that is not UI:**

- The poll loop, scheduling, and jitter.
- HTTP: the ODS Explore v2.1 feed and the Overpass brand directory, including
  the circuit breaker and retry policy (`watcher/http.ts`).
- Ingest / normalization (`watcher/ingest/`), including the Europe/Paris
  wall-clock reinterpretation.
- Domain: model, geo/haversine, edge detector, fuel filter.
- Brand directory build/match/merge.
- Authoritative state and persistence (`state.json` in the app data dir).
- Tray icon, application menu, window lifecycle.
- OS notifications.
- Tauri commands consumed by the UI.

**Frontend (`src/`) owns only the UI:** React + Mantine rendering, form state,
and calls into Rust via `invoke`. It no longer imports any `watcher/` or
`shared/` module and no longer performs polling or filtering itself.

### Tooling

- Node/npm replaces Deno for frontend tooling: `package.json` with Vite,
  React, Mantine, TypeScript, and `@tauri-apps/cli`.
- `deno.json`, `deno.lock`, `types/jsr.d.ts`, and all `jsr:` / `npm:` Deno
  import specifiers are removed.
- **Formatting and linting move to the oxc toolchain:** `oxfmt` (currently
  0.68.0) replaces `deno fmt`, and `oxlint` (currently 1.83.0) replaces
  `deno lint`. Both are Rust-native, understand TypeScript/TSX, and add no
  runtime dependency. `deno fmt --check . && deno lint .` (`deno.json:4`)
  becomes `oxfmt --check .` + `oxlint .` in npm scripts.
- **TypeScript stays.** `tsconfig.json` is already present and the existing
  `deno task typecheck` already runs `tsc --noEmit`, so `tsc --noEmit` remains
  the type checker and is **not** replaced by oxlint (oxlint is not a type
  checker). Note: `typescript` is currently not a declared dependency — the
  task relies on a globally installed `tsc` — so pin it in `package.json`
  devDependencies to make type checking reproducible. TypeScript compiles to
  plain JS; the Rust core is the only runtime.
- **Vitest for JavaScript/TypeScript tests.** `vitest` (currently 5.0.1) with
  `jsdom` and `@testing-library/react` replaces `deno test` for the UI and the
  Tauri client layer. Coverage via `@vitest/coverage-v8`.

### Testing

Two runners, split by where the logic lives:

- **Rust (`cargo test`)** — domain and adapters: `edge_detector`,
  `normalizer`, `fuel_filter`, `directory`, `http`, `app_state`. The existing
  `watcher/**/*_test.ts` and `shared/app_state_test.ts` suites are ported 1:1
  and are the behavioral oracle for the port.
- **Vitest (`npm test` / `vitest run`)** — everything still in TypeScript: the
  Tauri command wrappers in `src/state/client.ts` (mocking
  `@tauri-apps/api/core` `invoke`), the localStorage stores
  (`src/filters/store.ts`, `src/brands/store.ts`), and React components via
  `@testing-library/react` + `jsdom`. A `test:watch` script runs `vitest` in
  watch mode.

### The watcher becomes a Rust library

The pure domain and adapters are ported 1:1 to Rust and covered by Rust tests,
so the architectural intent of ADR 0001 (a host-agnostic, headlessly testable
watcher) survives even though the standalone Deno `watcher/main.ts` deliverable
is retired. The Tauri app is now the single deliverable.

### Notifications

Use `tauri-plugin-notification` (Rust side), replacing the Web Notifications
API in `notify.ts`. The notification payload (fuel, price, station, distance,
`maj`, "worth calling" note) is unchanged.

Known desktop limitation: the plugin does not expose notification-click events
(`onAction` is mobile-only) and does not support the Web Notifications `tag`
dedupe field. The current behavior of clicking a notification to focus the
window and open Google Maps is therefore not directly reproducible; see
Consequences.

### Tray icon and menu

- Enable the `tray-icon` feature of the `tauri` crate.
- Build the tray with `TrayIconBuilder`, reusing the menu ids and accelerators
  from `desktop.ts` (`reload`, `open`, `devtools`, `quit`, plus the Edit roles).
- Use `.icon_as_template(true)` on macOS so a single monochrome icon adapts to
  light/dark, replacing the separate light/dark base64 icons.
- Closing the window hides it (`CloseRequested` + `prevent_close`); quit is
  explicit via the menu/tray. Restore the window on macOS dock `Reopen`.
- Add `tauri-plugin-single-instance` so a second launch cannot create a
  duplicate tray icon or a second poll loop.

### State and IPC

- Replace the `/api/*` HTTP routes with Tauri commands: `get_state`,
  `update_filters`, `get_results`, `refresh`, `get_brands`,
  `notification_permission`.
- `src/state/client.ts` is rewritten to call `invoke`; its public function
  signatures stay the same so `src/App.tsx` needs minimal changes.
- Persistence uses `app.path().app_data_dir()` + serde JSON, replacing the
  hand-rolled OS path switch in `state-store.ts`.

### Release

Replace the `deno desktop` workflow with `tauri-apps/tauri-action@v0` across a
matrix (macOS arm64/x64, Windows x64, Linux x64). Tauri installers (`.dmg` /
`.app`, `.msi` / NSIS, `.AppImage` / `.deb`) replace the Deno outputs.

## Module mapping

| Current (TypeScript)              | Target (Rust)             | Notes                                  |
| --------------------------------- | ------------------------- | -------------------------------------- |
| `watcher/domain/model.ts`         | `domain/model.rs`         | serde types; `FuelCode` enum           |
| `watcher/domain/geo.ts`           | `domain/geo.rs`           | haversine                              |
| `watcher/domain/edge-detector.ts` | `domain/edge_detector.rs` | port tests verbatim                    |
| `watcher/domain/fuel-filter.ts`   | `domain/fuel_filter.rs`   |                                        |
| `watcher/ingest/raw-record.ts`    | `ingest/raw_record.rs`    | `#[derive(Deserialize)]`               |
| `watcher/ingest/normalizer.ts`    | `ingest/normalizer.rs`    | `chrono-tz` for Europe/Paris           |
| `watcher/feed/ods-feed.ts`        | `feed/ods.rs`             | `reqwest` (rustls)                     |
| `watcher/brands/directory.ts`     | `brands/directory.rs`     |                                        |
| `watcher/brands/overpass.ts`      | `brands/overpass.rs`      | `reqwest` + timeout                    |
| `watcher/http.ts`                 | `http.rs`                 | circuit breaker + retry, `tokio::time` |
| `watcher/ports.ts`                | traits in `ports.rs`      | retained as seams                      |
| `watcher/util/log.ts`             | `log.rs`                  | `tracing` or JSON logger               |
| `shared/app-state.ts`             | `app_state.rs`            | filters, trackers, snapshot            |
| `shared/station-query.ts`         | `station_query.rs`        | match/sort/maps URL                    |
| `state-store.ts`                  | `state_store.rs`          | app data dir                           |
| `poller.ts`                       | `poller.rs`               | tokio task + notification plugin       |
| `api.ts`                          | `commands.rs`             | `#[tauri::command]`                    |
| `desktop.ts`                      | `tray.rs`, `menu.rs`      | tray/menu/window lifecycle             |
| `notify.ts`                       | `notifications.rs`        | `tauri-plugin-notification`            |
| `server.ts`, `dev-server.ts`      | —                         | removed (no HTTP server)               |

Headless-only modules that are **not** ported (`watcher/app/*`,
`watcher/selection.ts`, `watcher/config.ts`, `watcher/state/sqlite-store.ts`,
`watcher/notify/ntfy.ts`, `watcher/main.ts`, `watcher/composition.ts`) are
retired with the Deno headless deliverable.

## Migration phases

1. **Tooling.** Add `package.json` with `oxlint`, `oxfmt`, `typescript`,
   `vitest`, `jsdom`, `@testing-library/react`, `@vitest/coverage-v8`, and
   `@tauri-apps/cli`; add `lint` / `fmt` / `typecheck` / `test` scripts
   (`oxlint .`, `oxfmt --check .`, `tsc --noEmit`, `vitest run`); remove
   `deno.json`, `deno.lock`, `types/jsr.d.ts`; drop the `deno` types from
   `tsconfig.json`.
2. **Scaffold.** Add `src-tauri/` (`tauri.conf.json`, `Cargo.toml`,
   `capabilities/default.json`, `icons/`). Configure `frontendDist`, `devUrl`,
   `beforeDevCommand`, `beforeBuildCommand`, window size/title, bundle targets.
3. **Domain port.** Port `domain/` + `ingest/` + `brands/directory` + `http`,
   porting the corresponding `_test.ts` suites to Rust `#[cfg(test)]`.
4. **Adapters + state.** Port the ODS and Overpass clients and the state store;
   implement Tauri commands.
5. **Poller + notifications.** Port the poll loop; wire
   `tauri-plugin-notification` and `tauri-plugin-opener`.
6. **Tray + menu.** Port `desktop.ts` to `TrayIconBuilder` / menu builders;
   implement close-to-hide and dock reopen.
7. **Frontend.** Rewrite `src/state/client.ts` to `invoke`; add Vitest tests
   for the client wrappers and stores; remove the client-side polling fallback
   and `watcher/` imports from `src/App.tsx`.
8. **Release.** Rewrite the GitHub Actions workflow around `tauri-action`.
9. **Cleanup.** Delete the Deno backend files and `watcher/` + `shared/` TS
   once the Rust ports pass; update the README.

## Consequences

Positive:

- One small native binary per platform; no Deno, no sidecar, no bundled
  Chromium.
- A single source of truth for domain logic (Rust), with tests in the same
  language as the runtime.
- Native tooling replaces the Deno runtime across the board: `oxlint`/`oxfmt`
  for lint/format, `cargo test` + `vitest` for tests.
- Standard Tauri ecosystem for signing, notarization, installers, and optional
  auto-update.

Negative / risks to manage:

- **Large port.** `edge-detector`, `normalizer`, `fuel-filter`, `directory`,
  and `app-state` must be translated carefully; the TS test suites are the
  reference oracle.
- **Notification click-through regresses.** Desktop Tauri notifications have no
  click callback and no `tag`. The window-focus + Google Maps deep link from
  `notify.ts` is lost unless custom platform code is added later.
- **Windows backend changes.** Deno used CEF to avoid WebView2; Tauri is
  WebView2-only. The installer can bootstrap/offline-install the runtime, but
  this is a real behavioral change from the current Windows `.msi`.
- **No more browser-only fallback.** Because polling and filtering move to
  Rust, the localStorage/client-side mode in `src/App.tsx` is removed; the UI
  requires the Tauri core.
- **Platform polish.** macOS notifications/tray are best with a signed app;
  Linux tray requires `libayatana-appindicator` and does not emit tray click
  events.
- **ADR 0001 superseded in part.** The standalone Deno headless watcher and its
  host-agnostic composition root are retired; the watcher now lives inside the
  Tauri app. The pure domain remains headlessly testable via `cargo test`.

## Deferred decisions / open questions

- Whether to add macOS code signing / notarization and Windows signing in CI.
- Whether to add `tauri-plugin-updater` for auto-updates.
- Whether to reintroduce a standalone headless watcher (in Rust) if an
  always-on off-box deployment is still wanted.
- Whether notification click-through is worth custom per-platform code.
