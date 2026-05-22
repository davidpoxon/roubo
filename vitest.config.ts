import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
