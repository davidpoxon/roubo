import { expect, test } from "@playwright/test";
import {
  expectStubConnectionStatus,
  loadAppShell,
  resetWithScenario,
} from "./_support/scenario.js";

// TC-156 (US-001, FR-001/005/019/021/034/039): the github.com baseline source
// config flow. The full user journey (OAuth, repo picker, cut list, bench
// creation) requires a registered-project fixture wired to the stubbed
// integration. That fixture lands with the deeper drilldown of this TC
// tracked separately; this spec proves the harness contract end-to-end under
// the pinned scenario: the github-com-multi-list scenario reaches the spawned
// plugin and its responses surface via the host HTTP surface.

const SCENARIO = "github-com-multi-list";
const NOW = "2026-05-21T12:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("github-com-multi-list scenario surfaces via the host connection-status endpoint", async ({
  request,
  page,
}) => {
  await expectStubConnectionStatus(request, {
    detail: "github-com stub",
    checkedAt: NOW,
  });
  await loadAppShell(page);
});

test("listing installed plugins includes the e2e-stub under this scenario", async ({ request }) => {
  const res = await request.get("/api/plugins");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { plugins: Array<{ id: string; status: string }> };
  const stub = body.plugins.find((p) => p.id === "e2e-stub");
  expect(stub).toBeDefined();
  expect(stub?.status).toBe("enabled");
});
