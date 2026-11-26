import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { WATCH_TEST_FILES, WATCH_TEST_TIMEOUT_MS } from "./server/test/watch-project.js";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    restoreMocks: true,
    // Bounded retry for the suite-wide Vitest-at-scale mock-isolation flake
    // tracked in #305. Under a full run the forks pool occasionally lets one
    // file's module mock bleed into another that mocks the same module
    // differently, so a (random) route test reads a foreign value and asserts
    // the wrong HTTP status. We removed the leak sources we could pin down
    // (version-check.test.ts global-fetch stub, fake-timer teardown gaps), but
    // a residual flake remains inside Vitest's own per-file isolation that no
    // available config or pool option (forks/threads) eliminates. This bounded
    // retry re-runs only the failed test (re-establishing its mocks) to keep CI
    // green while #305 stays open for a root-cause fix upstream. It is a
    // stabilizer, not a fix: it also masks other genuinely intermittent tests.
    retry: 1,
    environmentMatchGlobs: [["client/src/**", "jsdom"]],
    setupFiles: ["./client/src/test/setup.ts"],
    // Two projects in one run. `fs-watch` holds the tests that wait on real
    // file-system watches, settle windows and child processes, and gives them
    // one test timeout (#1726). The list and the budgets are in
    // server/test/watch-project.ts. Vitest queues the files of the projects in
    // the order of their names, so the name must sort before `main`: queued
    // last, the watch files start only once `main` is almost done, and the run
    // takes about 15 s longer.
    projects: [
      {
        extends: true,
        test: {
          name: "fs-watch",
          include: WATCH_TEST_FILES,
          testTimeout: WATCH_TEST_TIMEOUT_MS,
          hookTimeout: WATCH_TEST_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        test: {
          name: "main",
          include: [
            "server/**/*.test.ts",
            "client/src/**/*.test.{ts,tsx}",
            "bin/**/*.test.ts",
            "scripts/**/*.test.ts",
            "shared/**/*.test.ts",
            "electron/**/*.test.ts",
            "plugin-sdk/src/**/*.test.ts",
            "e2e/fixtures/stubbed-plugin/src/**/*.test.ts",
            "e2e/fixtures/clasp-deploy-stub/src/**/*.test.ts",
          ],
          exclude: [...configDefaults.exclude, ...WATCH_TEST_FILES],
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: [
        "client/src/**/*.{ts,tsx}",
        "server/**/*.{ts,tsx}",
        "shared/**/*.ts",
        "electron/src/**/*.ts",
        "plugin-sdk/src/**/*.ts",
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
