import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";

const DEV_PORT = 5180;

export default defineConfig({
  plugins: [svelte()],
  base: "/-/static-plugins/datasette_share/",
  build: {
    target: "esnext",
    outDir: path.resolve(__dirname, "../datasette_share"),
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
