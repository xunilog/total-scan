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

interface DesktopWindow {
  setApplicationMenu(menu: DesktopMenu): void;
  addEventListener(
    type: "menuclick",
    listener: (e: CustomEvent<{ id: string }>) => void,
  ): void;
  show(): void;
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

interface DesktopApi {
  BrowserWindow?: new (
    options: { title?: string; width?: number; height?: number },
  ) => DesktopWindow;
  Tray?: new () => DesktopTray;
}

function pngBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export function setupDesktop(): void {
  const { BrowserWindow, Tray } = Deno as unknown as DesktopApi;

  if (typeof BrowserWindow !== "function" || typeof Tray !== "function") {
    return;
  }

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
          { role: { role: "quit" } },
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
    }
  });

  const tray = new Tray();
  tray.setIcon(pngBytes(TRAY_ICON_LIGHT));
  tray.setIconDark(pngBytes(TRAY_ICON_DARK));
  tray.setTooltip("Scan Carburant");
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

  tray.addEventListener("click", showWindow);
  tray.addEventListener("menuclick", (e) => {
    switch (e.detail.id) {
      case "open":
        showWindow();
        break;
      case "quit":
        Deno.exit(0);
        break;
    }
  });
}
