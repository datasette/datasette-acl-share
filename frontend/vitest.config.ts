import { defineConfig } from "vitest/config";

// Unit tests for the framework-agnostic API client (src/lib/*.ts). The client
// is plain TypeScript with an injectable fetch, so the default node-ish
// environment is sufficient — no jsdom needed.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
