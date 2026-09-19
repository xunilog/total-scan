// Deno-side persistence for the desktop app's shared state.
//
// Written by the tray/poller process so filters, the brand cache, and the edge
// detector's tracker survive a window close or a full restart. The webview
// never touches this file directly; it goes through `/api/state`.

import { dirname, join } from "node:path";
import {
  type AppState,
  createInitialState,
  normalizeState,
} from "./shared/app-state.ts";

const APP_DIR_NAME = "ScanCarburant";
const STATE_FILE_NAME = "state.json";

export function appDataDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? ".";
  switch (Deno.build.os) {
    case "windows": {
      const appData = Deno.env.get("APPDATA");
      return appData ? join(appData, APP_DIR_NAME) : join(home, APP_DIR_NAME);
    }
    case "darwin":
      return join(home, "Library", "Application Support", APP_DIR_NAME);
    default: {
      const xdg = Deno.env.get("XDG_DATA_HOME");
      return join(xdg ?? join(home, ".local", "share"), APP_DIR_NAME);
    }
  }
}

export function stateFilePath(): string {
  return join(appDataDir(), STATE_FILE_NAME);
}

export async function loadState(
  path: string = stateFilePath(),
): Promise<AppState> {
  try {
    const raw = await Deno.readTextFile(path);
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      // A corrupt state file should not stop the app; fall back to defaults.
      console.error("failed to read state, using defaults", error);
    }
    return createInitialState();
  }
}

export async function saveState(
  state: AppState,
  path: string = stateFilePath(),
): Promise<void> {
  const directory = dirname(path);
  await Deno.mkdir(directory, { recursive: true });
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(state, null, 2));
  await Deno.rename(tmp, path);
}
