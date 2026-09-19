# Scan Carburant

A minimal desktop app built with [Vite](https://vite.dev) + React +
[Mantine](https://mantine.dev), packaged as a native binary with
[`deno desktop`](https://docs.deno.com/runtime/desktop/) (Deno 2.9+).

It shows a "Hello, world!" Mantine card with a counter, plus a native
application menu and a system-tray icon with its own menu.

See
[docs/adr/0001-watcher-architecture.md](docs/adr/0001-watcher-architecture.md)
for the planned fuel-availability watcher architecture.

## Requirements

- [Deno](https://docs.deno.com/runtime/getting_started/installation) 2.9 or
  newer.

## Development

```sh
deno task dev          # Vite dev server in a browser (http://localhost:5173)
deno task desktop:dev  # Vite dev server inside the desktop runtime (HMR + tray)
```

`deno task desktop:dev` runs the Vite dev server inside the desktop runtime, so
the native window and tray are set up while you edit; the webview points at the
dev server for fast refresh.

## Build a native app

```sh
deno task desktop      # -> release/ScanCarburant.app (macOS)
open release/ScanCarburant.app
```

The extension of `desktop.output.<platform>` in `deno.json` selects the format
(`.app` / `.dmg` on macOS, `.exe` / `.msi` on Windows, `.AppImage` / `.deb` /
`.rpm` on Linux). Cross-compile with `--target` / `--all-targets`.

## Layout

| Path                 | Purpose                                                    |
| -------------------- | ---------------------------------------------------------- |
| `index.html`         | Vite entry document                                        |
| `src/main.tsx`       | React root, Mantine provider                               |
| `src/App.tsx`        | Hello-world UI                                             |
| `server.ts`          | `deno desktop` entry: serves `dist/` and installs the tray |
| `desktop.ts`         | Native window, application menu, and tray setup            |
| `vite.config.ts`     | React plugin + a dev-only plugin that installs the tray    |
| `postcss.config.cjs` | Mantine's PostCSS preset                                   |
| `static/`            | App icon + tray icons                                      |

## Notes

- `deno desktop` detects the `server.ts` next to `vite.config.ts` as a Vite
  server entry, so it runs `deno task build`, embeds `dist/`, and imports
  `server.ts` inside the desktop runtime.
- The desktop APIs (`Deno.BrowserWindow`, `Deno.Tray`) only exist inside
  `deno desktop`; `setupDesktop()` no-ops elsewhere, so the app also runs as a
  plain web server (`deno run -A server.ts`).
- Always run the desktop tasks rather than `deno desktop` directly: they clear
  `release/` first. The runtime extracts its embedded files next to the binary,
  and Deno would otherwise embed that extracted `node_modules` on the next
  build.
