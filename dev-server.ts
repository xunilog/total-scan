// Dev-server bridge.
//
// Runs the same `handleApi` + `DesktopPoller` inside the Vite dev server, so
// `deno task desktop:dev` exercises the real background polling path (including
// OS notifications, since that Vite server runs inside the `deno desktop`
// runtime) and `deno task dev` gets the API in a browser.
//
// The poller is a singleton on `globalThis` so Vite config reloads reuse it
// instead of starting a second poll loop.

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApi } from "./api.ts";
import type { DesktopWindow } from "./desktop.ts";
import { createDesktopNotifier } from "./notify.ts";
import { DesktopPoller } from "./poller.ts";
import { loadState } from "./state-store.ts";

const POLLER_KEY = Symbol.for("total-scan.dev-poller");

type DevGlobals = typeof globalThis & { [POLLER_KEY]?: DesktopPoller };

export async function getDevPoller(
  win: DesktopWindow | null,
): Promise<DesktopPoller> {
  const globals = globalThis as DevGlobals;
  const existing = globals[POLLER_KEY];
  if (existing) return existing;

  const notifier = createDesktopNotifier({
    focus: () => {
      win?.show();
      win?.focus();
    },
  });
  const poller = new DesktopPoller({ state: await loadState(), notifier });
  globals[POLLER_KEY] = poller;
  poller.start();
  return poller;
}

function headersFromNode(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

async function bodyFromNode(
  req: IncomingMessage,
): Promise<ArrayBuffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
    );
  }
  if (chunks.length === 0) return undefined;
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const buffer = new ArrayBuffer(total);
  const view = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    view.set(chunk, offset);
    offset += chunk.length;
  }
  return buffer;
}

export function createApiMiddleware(poller: DesktopPoller) {
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    if (!req.url?.startsWith("/api/")) {
      next();
      return;
    }
    const host = req.headers.host ?? "127.0.0.1";
    const request = new Request(new URL(req.url, `http://${host}`), {
      method: req.method,
      headers: headersFromNode(req),
      body: await bodyFromNode(req),
    });
    const response = await handleApi(request, poller);
    if (!response) {
      next();
      return;
    }
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(new Uint8Array(await response.arrayBuffer()));
  };
}
