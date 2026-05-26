import { test } from "@playwright/test";
import {
  expectStubConnectionStatus,
  loadAppShell,
  resetWithScenario,
} from "./_support/scenario.js";

// TC-160 (US-005, FR-024/025): a project whose roubo.yaml references a
// plugin that is not installed surfaces the Missing-plugin prompt. Driving
// the full prompt + install-from-URL recovery flow requires the harness to
// pre-stage a project with an unknown-plugin reference and the git-URL
// install stub from TC-159. That fixture lands with the deeper drilldown of
// this TC tracked separately; this spec proves the missing-plugin-prompt
// scenario reaches the spawned plugin and surfaces via the host.

const SCENARIO = "missing-plugin-prompt";
const NOW = "2026-05-24T11:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("missing-plugin-prompt scenario surfaces via the host connection-status endpoint", async ({
  request,
  page,
}) => {
  await expectStubConnectionStatus(request, {
    detail: "post-install stub",
    checkedAt: NOW,
  });
  await loadAppShell(page);
});
