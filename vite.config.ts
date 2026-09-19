import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { setupDesktop } from "./desktop.ts";

export default defineConfig({
  plugins: [
    react(),
    {
      // Runs when the dev server starts. Under `deno desktop --hmr .` that
      // dev server lives inside the desktop runtime, so the native window and
      // tray are set up here too. Under plain `deno task dev` it is a no-op.
      name: "deno-desktop",
      configureServer() {
        setupDesktop();
      },
    },
  ],
  build: {
    outDir: "dist",
  },
});
