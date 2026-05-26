import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Two test projects:
//   node     — fast unit tests for the framework-agnostic helpers (the API
//              client + pure grant/avatar helpers). Injectable fetch, no DOM.
//   browser  — component tests for <datasette-share-dialog>, run in a real
//              browser (Playwright/chromium) via vitest-browser-svelte so
//              custom-element registration, DOM events and avatar <img>
//              onerror fallbacks behave exactly as in production.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/lib/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        // The browser project needs the Svelte plugin to compile components.
        plugins: [svelte()],
        test: {
          name: "browser",
          include: ["src/**/*.svelte.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            provider: "playwright",
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
