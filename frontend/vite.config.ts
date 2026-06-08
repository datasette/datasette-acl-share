import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";

// Dev-server port. Owned by the justfile (`DEV_PORT` var) and passed in via
// env so the number lives in one place; falls back to 5180 for a bare
// `npm run dev`. Only the dev server uses it (`build` ignores `server`).
const DEV_PORT = Number(process.env.DEV_PORT) || 5180;

export default defineConfig({
  plugins: [svelte()],
  base: "/",
  build: {
    target: "esnext",
    outDir: path.resolve(__dirname, "../datasette_acl_share"),
    assetsDir: "static/gen",
    emptyOutDir: false,
    manifest: "manifest.json",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "src/main.ts"),
      },
    },
  },
  server: {
    port: DEV_PORT,
    strictPort: true,
    cors: true,
    origin: `http://localhost:${DEV_PORT}`,
    hmr: { host: "localhost", port: DEV_PORT, protocol: "ws" },
  },
});
