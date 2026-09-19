// Native OS notifications for the desktop app.
//
// Only meaningful inside `deno desktop`, where the Web Notifications API is
// backed by the OS. In a plain `deno run server.ts` the global `Notification`
// does not exist, so this degrades to a no-op. The Deno/tray process owns
// polling, so it can raise notifications even when no window is open.

export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  readonly tag?: string;
}

export interface DesktopNotifier {
  available(): boolean;
  requestPermission(): Promise<boolean>;
  notify(payload: NotificationPayload): Promise<void>;
}

export interface NotifierOptions {
  readonly focus?: () => void;
}

function notificationApi(): typeof Notification | null {
  const api = (globalThis as { Notification?: typeof Notification })
    .Notification;
  return typeof api === "function" ? api : null;
}

async function ensurePermission(api: typeof Notification): Promise<boolean> {
  if (api.permission === "granted") return true;
  if (api.permission === "denied") return false;
  try {
    return (await api.requestPermission()) === "granted";
  } catch {
    return false;
  }
}

async function openExternal(url: string): Promise<void> {
  const command = Deno.build.os === "darwin"
    ? new Deno.Command("open", { args: [url] })
    : Deno.build.os === "windows"
    ? new Deno.Command("cmd", { args: ["/c", "start", "", url] })
    : new Deno.Command("xdg-open", { args: [url] });
  await command.output();
}

export function createDesktopNotifier(
  options: NotifierOptions = {},
): DesktopNotifier {
  return {
    available: () => notificationApi() !== null,

    async requestPermission(): Promise<boolean> {
      const api = notificationApi();
      if (!api) return false;
      return await ensurePermission(api);
    },

    async notify(payload: NotificationPayload): Promise<void> {
      const api = notificationApi();
      if (!api) return;
      if (!(await ensurePermission(api))) return;

      const notification = new api(payload.title, {
        body: payload.body,
        tag: payload.tag,
        data: payload.url ? { url: payload.url } : undefined,
      });
      notification.addEventListener("click", () => {
        options.focus?.();
        if (!payload.url) return;
        openExternal(payload.url).catch((error: unknown) => {
          console.error(
            "failed to open notification link",
            error instanceof Error ? error.message : String(error),
          );
        });
      });
    },
  };
}
