import { expect, test } from "@playwright/test";
import {
  crashStubPlugin,
  fetchPluginRecord,
  registerFixtureProject,
  resetWithScenario,
  waitForPluginRecord,
} from "../e2e-flow/_support/scenario.js";

// TC-163 (#240, US-009, FR-013/FR-014/FR-015, NFR-018, NFR-024): drive the
// stubbed plugin through 2 unexpected exits + auto-restart, force a 3rd
// strike into `errored`, verify the cut-list still serves the last-good
// snapshot, and observe the crash entries through the in-app log viewer.
//
// The mid-flight crashes are injected via `POST /test/__crash-plugin` (a
// ROUBO_E2E=1-gated SIGKILL); we wait on observable state (`restartHistory`
// length, status, pid) between crashes rather than on `setTimeout` durations,
// which keeps the spec deterministic against the 500ms / 1000ms / 2000ms
// backoff schedule under CI variance (NFR-018).

const SCENARIO = "plugin-crash-restart-escalation";
const NOW = "2026-05-27T09:00:00.000Z";
const STUB_PLUGIN_ID = "e2e-stub";

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("plugin crash + auto-restart + errored serves last-good snapshot and surfaces crash log entries (TC-163)", async ({
  page,
  request,
}) => {
  const { projectId } = await registerFixtureProject(request, {
    projectId: "tc-163",
    plugin: STUB_PLUGIN_ID,
  });

  // Sanity: the stub is up and the scenario data flows through `listIssues`.
  // This pull also populates the FR-014 last-good snapshot cache.
  const initialIssuesRes = await request.get(`/api/projects/${projectId}/issues`);
  expect(initialIssuesRes.status()).toBe(200);
  const initialBody = (await initialIssuesRes.json()) as {
    items: Array<{ externalId: string; title: string }>;
    stale?: boolean;
  };
  expect(initialBody.stale).toBeUndefined();
  expect(initialBody.items.map((i) => i.externalId)).toEqual([
    "acme/widgets#501",
    "acme/widgets#502",
  ]);

  // Confirm the stub is running before the first crash so the SIGKILL targets
  // a live pid (rather than racing initialize()).
  await waitForPluginRecord(
    request,
    STUB_PLUGIN_ID,
    (r) => r.status === "enabled" && r.pid !== null,
  );

  // Crash 1: handleChildExit pushes a restart entry, schedules respawn at
  // 500ms. We wait first for the history to grow (the SIGKILL has registered)
  // and then for status=enabled + a new pid (the respawn completed).
  await crashStubPlugin(request, STUB_PLUGIN_ID);
  await waitForPluginRecord(request, STUB_PLUGIN_ID, (r) => r.restartHistory.length >= 1);
  await waitForPluginRecord(
    request,
    STUB_PLUGIN_ID,
    (r) => r.status === "enabled" && r.pid !== null,
  );

  // Crash 2: same shape, backoff now 1000ms.
  await crashStubPlugin(request, STUB_PLUGIN_ID);
  await waitForPluginRecord(request, STUB_PLUGIN_ID, (r) => r.restartHistory.length >= 2);
  await waitForPluginRecord(
    request,
    STUB_PLUGIN_ID,
    (r) => r.status === "enabled" && r.pid !== null,
  );

  // Crash 3: restart-budget exhausted. handleChildExit short-circuits and
  // marks the record errored without scheduling another respawn.
  await crashStubPlugin(request, STUB_PLUGIN_ID);
  const erroredRecord = await waitForPluginRecord(
    request,
    STUB_PLUGIN_ID,
    (r) => r.status === "errored",
  );
  expect(erroredRecord.restartHistory.length).toBe(3);
  expect(erroredRecord.lastError?.code).toBe("restart-budget-exhausted");

  // FR-014: while the plugin is errored, `/issues` serves the cached first
  // page with `stale: true` and the timestamp of the original snapshot.
  const erroredIssuesRes = await request.get(`/api/projects/${projectId}/issues`);
  expect(erroredIssuesRes.status()).toBe(200);
  const erroredBody = (await erroredIssuesRes.json()) as {
    items: Array<{ externalId: string }>;
    stale?: boolean;
    snapshotCapturedAt?: string;
  };
  expect(erroredBody.stale).toBe(true);
  expect(typeof erroredBody.snapshotCapturedAt).toBe("string");
  expect(erroredBody.items.map((i) => i.externalId)).toEqual([
    "acme/widgets#501",
    "acme/widgets#502",
  ]);

  // FR-015: the user opens the Plugins settings page, sees the errored
  // banner on the e2e-stub card, and the View logs dialog surfaces the three
  // host-side "plugin exited" warn lines plus the final
  // restart-budget-exhausted error line.
  await page.goto("/settings#plugins");
  const card = page.locator(`[data-plugin-id="${STUB_PLUGIN_ID}"]`);
  const banner = card.getByTestId("plugin-errored-banner");
  await expect(banner).toBeVisible();
  // PluginCard also exposes an always-on "View logs" action in its action row;
  // scope the click to the banner's own button so the spec mirrors the user
  // flow described in TC-163 ("user opens the log viewer from the errored
  // surface") rather than incidentally exercising the global action.
  await banner.getByRole("button", { name: "View logs" }).click();
  const dialog = page.getByRole("dialog");
  const logContent = dialog.getByTestId("log-content");
  await expect(logContent).toBeVisible();
  // Each crash produces a `plugin exited (code=...); restarting in <ms>ms
  // (attempt N/3)` warn line for N=1 and N=2, plus the final error line
  // "Plugin exited 3 times within 300s; auto-restart disabled. Click Restart
  // to retry." (`plugin-manager.ts:684,676`). Use `toContainText` against the
  // full dialog text so we don't get tripped up by Playwright's strict-mode
  // multi-element matching on a substring regex (the three crash lines share
  // the same `plugin exited (...)` prefix, so a single regex resolves to
  // multiple elements).
  await expect(logContent).toContainText("attempt 1/3");
  await expect(logContent).toContainText("attempt 2/3");
  await expect(logContent).toContainText("auto-restart disabled");

  // Belt-and-braces: confirm the running plugin record we asserted via the
  // /api/plugins endpoint still matches what the route layer sees, so the
  // banner above is reflecting the same state as the server.
  const finalRecord = await fetchPluginRecord(request, STUB_PLUGIN_ID);
  expect(finalRecord?.status).toBe("errored");
});
