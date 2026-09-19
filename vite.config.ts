import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { setupDesktop } from "./desktop.ts";
import { createApiMiddleware, getDevPoller } from "./dev-server.ts";

export default defineConfig({
  plugins: [
    react(),
    {
      // Runs when the dev server starts. Under `deno desktop --hmr .` that
      // dev server lives inside the desktop runtime, so the native window,
      // tray, background poller, and `/api/*` endpoints are all available
      // while you edit. Under plain `deno task dev` the window/tray no-op but
      // the API still runs.
      name: "deno-desktop",
      async configureServer(server) {
        const win = setupDesktop();
        const poller = await getDevPoller(win);
        server.middlewares.use(createApiMiddleware(poller));
      },
    },
  ],
  build: {
    outDir: "dist",
  },
});
