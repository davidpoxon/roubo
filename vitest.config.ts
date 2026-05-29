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
    // Bounded retry for the suite-wide Vitest-at-scale mock-isolation flake
    // tracked in #293. Under a full run the forks pool occasionally lets one
    // file's module mock bleed into another that mocks the same module
    // differently, so a (random) route test reads a foreign value and asserts
    // the wrong HTTP status. We removed the leak sources we could pin down
    // (version-check.test.ts global-fetch stub, fake-timer teardown gaps), but
    // a residual flake remains inside Vitest's own per-file isolation that no
    // available config or pool option (forks/threads) eliminates. This bounded
    // retry re-runs only the failed test (re-establishing its mocks) to keep CI
    // green while #293 stays open for a root-cause fix upstream. It is a
    // stabilizer, not a fix: it also masks other genuinely intermittent tests.
    retry: 1,
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
