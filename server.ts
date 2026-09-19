// Production entry point for `deno desktop`.
//
// `deno desktop .` detects the `server.ts` next to `vite.config.ts` as a Vite
// SSR/SPA server entry, runs `deno task build`, embeds `dist/`, and imports
// this module inside the desktop runtime. It serves the Vite build output and
// installs the native window / menu / tray.
//
// It also runs as a plain HTTP server (`deno run -A server.ts`), where the
// desktop setup is a no-op.

import { serveDir } from "@std/http/file-server";
import { setupDesktop } from "./desktop.ts";

setupDesktop();

const fsRoot = `${import.meta.dirname}/dist`;

Deno.serve(async (req) => {
  const res = await serveDir(req, { fsRoot, quiet: true });

  // SPA fallback: route unmatched HTML navigations back to index.html so
  // client-side routes survive a hard refresh.
  if (
    res.status === 404 &&
    req.method === "GET" &&
    (req.headers.get("accept") ?? "").includes("text/html")
  ) {
    const index = new Request(new URL("/index.html", req.url), {
      headers: req.headers,
    });
    return await serveDir(index, { fsRoot, quiet: true });
  }

  return res;
});
