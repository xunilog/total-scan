// JSON API over the shared app state, served by the Deno/tray process.
//
// The webview reads `/api/state` and `/api/results`, and writes filter changes
// back to `/api/state`. This is what lets polling continue with no window
// open: the poller never depends on the webview being alive.

import type { DesktopPoller } from "./poller.ts";
import { normalizeFilters } from "./shared/app-state.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export async function handleApi(
  req: Request,
  poller: DesktopPoller,
): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return null;

  if (url.pathname === "/api/state") {
    if (req.method === "GET") return json(poller.getState());
    if (req.method === "PUT") {
      const body = await req.json().catch(() => null) as
        | { filters?: unknown }
        | null;
      if (!body || typeof body !== "object" || body.filters === undefined) {
        return json({ error: "expected { filters }" }, 400);
      }
      const state = await poller.updateFilters(
        normalizeFilters(body.filters),
      );
      return json(state);
    }
    return json({ error: "method not allowed" }, 405);
  }

  if (url.pathname === "/api/results") {
    if (req.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }
    return json(poller.getSnapshot());
  }

  if (url.pathname === "/api/refresh") {
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    await poller.refresh();
    return json(poller.getSnapshot());
  }

  if (url.pathname === "/api/brands") {
    if (req.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }
    return json(poller.getState().brandDirectory);
  }

  if (url.pathname === "/api/notifications/permission") {
    if (req.method !== "POST") {
      return json({ error: "method not allowed" }, 405);
    }
    const granted = await poller.requestNotificationPermission();
    return json({ granted, available: poller.notificationsAvailable() });
  }

  return json({ error: "not found" }, 404);
}
