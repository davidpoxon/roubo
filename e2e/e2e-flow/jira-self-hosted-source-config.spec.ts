import { test } from "@playwright/test";
import {
  expectStubConnectionStatus,
  loadAppShell,
  resetWithScenario,
} from "./_support/scenario.js";

// TC-157 (US-002, FR-005/020/021/022/034/039): self-hosted Jira flow exercises
// the categorized-multi-list source-picker shape. The full PAT-paste +
// categorized picker UI lands once project-registration fixtures exist; this
// spec proves the categorized scenario reaches the spawned plugin and the
// host serves its responses with the pinned frozen clock.

const SCENARIO = "jira-self-hosted-categorized";
const NOW = "2026-05-21T13:00:00.000Z";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("jira-self-hosted-categorized scenario surfaces via the host connection-status endpoint", async ({
  request,
  page,
}) => {
  await expectStubConnectionStatus(request, {
    detail: "jira self-hosted stub",
    checkedAt: NOW,
  });
  await loadAppShell(page);
});
