import { test } from "@playwright/test";
import {
  expectStubConnectionStatus,
  loadAppShell,
  resetWithScenario,
} from "./_support/scenario.js";

// TC-158 (US-003, FR-026/027/028): legacy github.com user migration on first
// launch. Driving the full pre-populate ~/.roubo + migration banner +
// keyring writeback path requires the harness to boot the server pointed at
// a writable temp ROUBO_HOME with the legacy auth.json + project entry
// staged. That helper lands with the deeper drilldown of this TC tracked
// separately; this spec proves the migration-legacy-github scenario reaches
// the plugin and that the app shell still renders under that scenario.

const SCENARIO = "migration-legacy-github";
const NOW = "2026-05-21T14:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("migration-legacy-github scenario surfaces via the host connection-status endpoint", async ({
  request,
  page,
}) => {
  await expectStubConnectionStatus(request, {
    detail: "post-migration stub",
    checkedAt: NOW,
  });
  await loadAppShell(page);
});
