import { test } from "@playwright/test";
import {
  expectStubConnectionStatus,
  loadAppShell,
  resetWithScenario,
} from "./_support/scenario.js";

// TC-159 (US-004/US-007, FR-004/008/009/010/016): community plugin install
// from a git URL. Driving the full Settings > Plugins > Install > git URL >
// permissions-dialog flow requires an offline git-server stub and a clone
// target the host can resolve without network. That harness lands with the
// deeper drilldown of this TC tracked separately; this spec proves the
// community-plugin-install scenario reaches the spawned plugin and surfaces
// via the host.

const SCENARIO = "community-plugin-install";
const NOW = "2026-05-24T10:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("community-plugin-install scenario surfaces via the host connection-status endpoint", async ({
  request,
  page,
}) => {
  await expectStubConnectionStatus(request, {
    detail: "community plugin stub",
    checkedAt: NOW,
  });
  await loadAppShell(page);
});
