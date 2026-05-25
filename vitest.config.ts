import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Plugin tests under `plugins/{github-com,ghe}/src/__tests__/` import
      // transitively from `@roubo/shared-github`, which only exists at
      // `plugins/_shared-github/dist/` after a build step. CI runs tests
      // directly off `npm ci` (no build), so we alias the package to its
      // source entry to keep the test job hermetic.
      "@roubo/shared-github": fileURLToPath(
        new URL("./plugins/_shared-github/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    restoreMocks: true,
    include: [
      "server/**/*.test.ts",
      "client/src/**/*.test.{ts,tsx}",
      "bin/**/*.test.ts",
      "scripts/**/*.test.ts",
      "shared/**/*.test.ts",
      "electron/**/*.test.ts",
      "plugin-sdk/src/**/*.test.ts",
      "plugins/**/src/**/*.test.ts",
      "e2e/fixtures/stubbed-plugin/src/**/*.test.ts",
    ],
    environmentMatchGlobs: [["client/src/**", "jsdom"]],
    setupFiles: ["./client/src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "client/src/**/*.{ts,tsx}",
        "server/**/*.{ts,tsx}",
        "shared/**/*.ts",
        "electron/src/**/*.ts",
        "plugin-sdk/src/**/*.ts",
        "plugins/**/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/test/**",
        "server/dist/**",
        "**/node_modules/**",
        "electron/src/main.ts",
        "e2e/**",
        "client/source-picker-fixture.html",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
