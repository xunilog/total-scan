// Native desktop integration for `deno desktop`.
//
// `server.ts` imports `setupDesktop()` at the top level for the production
// binary, and `vite.config.ts` calls it from `configureServer` so the tray is
// also available while the Vite dev server runs inside `deno desktop --hmr`.
// Outside a desktop runtime (plain `deno run` / browser dev) the
// `Deno.Tray` / `Deno.BrowserWindow` APIs do not exist, so it is a no-op.
//
// `deno check --desktop` does not inject the desktop type library yet
// (denoland/deno#36085), so the APIs are described locally instead of
// relying on the global `Deno.*` declarations.
//
// Icons are embedded as base64 so they resolve identically from the dev
// tree and from the compiled binary's virtual filesystem.

const TRAY_ICON_LIGHT =
  "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAARUlEQVR42mNgGI7gPw5MdQMpsuA/iZgmhhJlOCkaSDKcVC8SpZ7cSCGob9TgIWwwzZIbTTMIJVn6/4CVF5QYPrAF/eAEACQPrVMM7kGDAAAAAElFTkSuQmCC";
const TRAY_ICON_DARK =
  "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAARklEQVR42mNgGHbgPw5AdQMpsuA/iYAmhhJlOCkaSDKcVC8SpZ7cSCGob9TgIWwwzZIbTTMIJVmaqOCjmcHkGj6wBf2gBQCJcrVnBP7KxAAAAABJRU5ErkJggg==";

interface DesktopMenuItem {
  item?: {
    label: string;
    id?: string;
    accelerator?: string;
    enabled: boolean;
  };
  submenu?: { label: string; items: DesktopMenu };
  role?: { role: string };
}

type DesktopMenu = Array<DesktopMenuItem | "separator">;

export interface DesktopWindow {
  setApplicationMenu(menu: DesktopMenu): void;
  addEventListener(
    type: "menuclick",
    listener: (e: CustomEvent<{ id: string }>) => void,
  ): void;
  addEventListener(type: "close", listener: (e: Event) => void): void;
  show(): void;
  hide(): void;
  focus(): void;
  reload(): void;
  openDevtools(): void;
}

interface DesktopTray {
  setIcon(pngBytes: Uint8Array): void;
  setIconDark(pngBytes: Uint8Array | null): void;
  setTooltip(text: string | null): void;
  setMenu(menu: DesktopMenu | null): void;
  addEventListener(type: "click", listener: (e: MouseEvent) => void): void;
  addEventListener(
    type: "menuclick",
    listener: (e: CustomEvent<{ id: string }>) => void,
  ): void;
}

interface DesktopDock {
  addEventListener(
    type: "reopen",
    listener: (e: CustomEvent<{ hasVisibleWindows: boolean }>) => void,
  ): void;
}

interface DesktopApi {
  BrowserWindow?: new (
    options: { title?: string; width?: number; height?: number },
  ) => DesktopWindow;
  Tray?: new () => DesktopTray;
  dock?: DesktopDock;
}

function pngBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function setupDesktop(): DesktopWindow | null {
  const { BrowserWindow, Tray, dock } = Deno as unknown as DesktopApi;

  if (typeof BrowserWindow !== "function" || typeof Tray !== "function") {
    return null;
  }

  // Set before terminating so the window `close` handler below does not treat
  // an intentional quit as a "hide the window" request.
  let quitting = false;
  const quit = () => {
    quitting = true;
    Deno.exit(0);
  };

  // The first BrowserWindow constructed adopts the implicit startup window.
  const win = new BrowserWindow({
    title: "Scan Carburant",
    width: 900,
    height: 640,
  });

  win.setApplicationMenu([
    {
      submenu: {
        label: "Scan Carburant",
        items: [
          { item: { label: "Reload", id: "reload", enabled: true } },
          "separator",
          {
            item: {
              label: "Quit Scan Carburant",
              id: "quit",
              accelerator: "CmdOrCtrl+Q",
              enabled: true,
            },
          },
        ],
      },
    },
    {
      submenu: {
        label: "File",
        items: [
          {
            item: {
              label: "Open Window",
              id: "open",
              accelerator: "CmdOrCtrl+O",
              enabled: true,
            },
          },
          "separator",
          { role: { role: "close" } },
        ],
      },
    },
    {
      submenu: {
        label: "Edit",
        items: [
          { role: { role: "undo" } },
          { role: { role: "redo" } },
          "separator",
          { role: { role: "cut" } },
          { role: { role: "copy" } },
          { role: { role: "paste" } },
          { role: { role: "selectAll" } },
        ],
      },
    },
    {
      submenu: {
        label: "View",
        items: [
          {
            item: {
              label: "Toggle DevTools",
              id: "devtools",
              accelerator: "CmdOrCtrl+Alt+I",
              enabled: true,
            },
          },
        ],
      },
    },
  ]);

  win.addEventListener("menuclick", (e) => {
    switch (e.detail.id) {
      case "reload":
        win.reload();
        break;
      case "open":
        win.show();
        win.focus();
        break;
      case "devtools":
        win.openDevtools();
        break;
      case "quit":
        quit();
        break;
    }
  });

  const tray = new Tray();
  tray.setIcon(pngBytes(TRAY_ICON_LIGHT));
  tray.setIconDark(pngBytes(TRAY_ICON_DARK));
  tray.setTooltip("Scan Carburant");

  // Tray-only: closing the window hides it so the process (and the Deno poll
  // loop) keeps running. Quit via the tray or the app menu.
  win.addEventListener("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  tray.setMenu([
    { item: { label: "Open Window", id: "open", enabled: true } },
    "separator",
    {
      item: {
        label: "Quit",
        id: "quit",
        accelerator: "CmdOrCtrl+Q",
        enabled: true,
      },
    },
  ]);

  const showWindow = () => {
    win.show();
    win.focus();
  };

  // With no visible window, macOS swallows the default dock reopen behavior;
  // restore the window when the dock icon is clicked.
  dock?.addEventListener("reopen", () => showWindow());

  tray.addEventListener("click", showWindow);
  tray.addEventListener("menuclick", (e) => {
    switch (e.detail.id) {
      case "open":
        showWindow();
        break;
      case "quit":
        quit();
        break;
    }
  });

  return win;
}
