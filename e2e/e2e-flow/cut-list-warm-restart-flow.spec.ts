import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  loadAppShell,
  readCutListCacheFile,
  resetWithScenario,
  setCutListDiskCacheEnabled,
} from "./_support/scenario.js";

// #567: the integration-level drift guard for the US-001 journey "warm cut list
// loads instantly after restart, then revalidates". It spans the slices #553,
// #559, #560, #561 and asserts the integrated journey against the authoritative
// e2e_flow case CLI-TC-001, not whatever any single slice implemented. This is
// the warm-restart sibling of the cut-list-refresh drift guard (#568 /
// CLI-TC-017); it is modelled closely on that spec (same imports, beforeEach /
// afterEach shape, badge / last-updated locators, warm-path technique, and
// FR-020 failure-message convention).
//
// REACHING THE WARM "AFTER RESTART" PRECONDITION. CLI-TC-001's preconditions are
// "a snapshot was persisted in a prior session" AND "the application has been
// fully quit and relaunched". The harness has no real process restart, so the
// e2e stand-in is: prime the disk snapshot with one cache-miss open (the live
// RPC runs and persists the first page under ~/.roubo/issue-snapshots/), then
// `page.reload()`. Reloading over the persisted on-disk snapshot warm-serves it
// exactly as a relaunch would (the in-process cache does not survive a reload of
// the SPA the same way it would not survive a relaunch), which is the
// documented e2e stand-in for "relaunched", mirroring TC-017's approach. The
// warm serve is only reachable when the disk path is un-bypassed: the harness
// bypasses it by default (NFR-018, so one scenario's snapshot is never served to
// a later spec), so beforeEach calls `setCutListDiskCacheEnabled(true)` and
// `/test/__reset` restores the bypass + wipes issue-snapshots/ for the next spec.
//
// CLI-TC-001 HARNESS ADAPTATIONS (decided: adapt to the e2e harness):
//
//   1. S001-O04 (RECONCILED, no longer a divergence; #592 reconciled the
//      wording). S001-O04 in the authoritative case now reads as the
//      e2e-level no-network-wait proxy this guard asserts: the first visible row
//      renders from the persisted on-disk snapshot without waiting on a live
//      network round-trip. That reconciled spec wording is now authoritative, and
//      this guard implements it exactly. We assert the proxy because a Playwright
//      run yields one noisy wall-clock sample, so a literal p95 budget would be
//      unsound and flaky here: on the warm serve the cache-state badge reads
//      `warm` (the shipped badge only reads `warm` when the server served the
//      persisted disk snapshot, cacheStatus 'revalidating'; a cold miss shows no
//      chip), so the `warm` badge + rendered rows are the integrated proof that
//      first meaningful paint came from the snapshot, not a cold network
//      round-trip. The literal <200ms p95 budget stays owned by the perf unit
//      test client/src/components/cut-list-warm-paint.perf.tc-011.test.tsx
//      (CLI-TC-011 / CLI-NFR-002). #592 reconciled S001-O04's spec wording to
//      this proxy (the audit trail for why the proxy stands in for the literal
//      budget).
//
//   2. S002 background revalidation is driven via the Refresh control. In the
//      shipped UI the `revalidating` badge state is client-refetch driven
//      (IssueQueuePanel's cacheState: `isRefetching` -> `revalidating`, else a
//      warm disk hit -> `warm`). The server's fire-and-forget background
//      revalidation behind a warm serve is NOT surfaced as a client `revalidating`
//      badge, and the query's staleTime (30s) means a fresh reload does not
//      auto-refetch. So the integrated, deterministic way to observe S002's
//      `warm -> revalidating -> warm` transition is to trigger a client
//      revalidation via the Refresh control (exactly as the sibling TC-017 guard
//      does) and hold its refetch open. This deliberate TC-001 divergence (manual
//      trigger standing in for "background revalidation runs") is tracked by #592.
//
// FR-020 failure-output contract: every assertion below carries a descriptive
// message naming the diverging e2e_flow step (S001/S002/S003 + observation id),
// the expected-vs-actual, and the owning slice issues #553/#559/#560/#561, so a
// regression points straight at the step and the slice that broke it.
//
// The fixture project (e2e/fixtures/cut-list-refresh-project) pins the e2e-stub
// plugin with one repository source; the scenario seeds three deterministic To
// Do cuts that fit one page, so the warm snapshot is the full first page.

const SCENARIO = "cut-list-refresh";
const NOW = "2026-05-21T13:00:00.000Z";
const OWNING_SLICES = "#553/#559/#560/#561";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_PATH = path.resolve(__dirname, "..", "fixtures", "cut-list-refresh-project");
const PROJECT_ID = "e2e-cut-list-refresh";

// The scenario's three To Do cuts, in stable externalId order.
const CUT_REFS = ["#301", "#302", "#303"] as const;

async function registerProject(request: APIRequestContext): Promise<void> {
  const cleanup = await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
  expect([204, 404]).toContain(cleanup.status());
  const res = await request.post("/api/projects", { data: { repoPath: REPO_PATH } });
  expect(res.status(), "register cut-list-refresh fixture project").toBe(201);
  const body = (await res.json()) as { id: string };
  expect(body.id).toBe(PROJECT_ID);
}

const cacheBadge = (page: Page) => page.getByTestId("cut-list-cache-state");
const lastUpdated = (page: Page) => page.getByTestId("cut-list-last-updated");
const refreshButton = (page: Page) => page.getByRole("button", { name: "Refresh cut list" });

async function expectRefsVisible(page: Page, step: string): Promise<void> {
  for (const ref of CUT_REFS) {
    await expect(
      page.getByText(ref, { exact: true }),
      `${step} (TC-001, slices ${OWNING_SLICES}): expected cut ${ref} to be visible`,
    ).toBeVisible();
  }
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
  await registerProject(request);
  // Un-bypass the disk cache so the warm-snapshot serve is reachable (see the
  // header note); /test/__reset in the next spec's beforeEach restores the
  // default.
  await setCutListDiskCacheEnabled(request, true);
});

test.afterEach(async ({ request }) => {
  await request.delete(`/api/projects/${PROJECT_ID}?force=true`);
});

test("TC-001: warm cut list loads instantly after restart, then revalidates", async ({
  page,
  request,
}) => {
  await loadAppShell(page);

  // Prime the disk snapshot: the first open is a cache miss that runs the live
  // RPC and persists the first page. Assert the rows so the snapshot is written
  // from a fully loaded list before we reload to warm-serve it.
  await page.goto(`/projects/${PROJECT_ID}`);
  await expectRefsVisible(page, "priming open (cache miss writes the snapshot)");

  // S001 (warm open after restart). `page.reload()` is the e2e stand-in for
  // "relaunched" (see header): the client remounts with an empty React Query
  // cache and the cut-list query's first fetch is warm-served from the persisted
  // disk snapshot (cacheStatus 'revalidating', isRefetching false -> the `warm`
  // badge), so the cached rows render and the indicator shows a relative
  // "updated ..." time. We do NOT hold this first request open: holding the
  // initial load would keep the panel on its skeleton (isLoading), never showing
  // the warm rows or the `warm` badge.
  await page.reload();

  // S001-O01: the warm serve renders the snapshot rows.
  await expectRefsVisible(page, "S001-O01 warm serve renders snapshot rows after restart");
  // S001-O02 / S001-O04 proxy: the cache-state badge reads "warm" on the warm
  // serve. Because the badge only reads `warm` when the row data came from the
  // persisted disk snapshot (a cold miss shows no chip), the `warm` badge over
  // rendered rows is the integrated proof that first meaningful paint came from
  // the snapshot, not a cold network round-trip (the literal <200ms p95 budget is
  // owned by the TC-011 perf unit test; divergence tracked by #592).
  await expect(
    cacheBadge(page),
    `S001-O02 (TC-001, slices ${OWNING_SLICES}): the cache-state badge must read "warm" on the warm serve after restart, got "${await cacheBadge(page).textContent()}"`,
  ).toHaveAttribute("data-state", "warm");
  // S001-O03: the last-updated indicator shows a relative "updated ..." time
  // (reflecting the snapshot), not "loading".
  await expect(
    lastUpdated(page),
    `S001-O03 (TC-001, slices ${OWNING_SLICES}): the last-updated indicator must show a relative "updated ..." time on the warm serve, not "loading", got "${await lastUpdated(page).textContent()}"`,
  ).toContainText(/^updated /);

  // S002 (background revalidation). The shipped `revalidating` badge state is
  // client-refetch driven (see header divergence #2), so we drive the
  // revalidation via the Refresh control and hold its refetch open with a
  // one-shot route delay, making the `warm -> revalidating -> warm` transition
  // deterministically observable (the same technique the sibling TC-017 guard
  // uses). The held window also lets us assert the existing rows stay visible
  // (keepPreviousData, no skeleton/loading flash).
  let releaseRevalidate: (() => void) | undefined;
  const revalidateHeld = new Promise<void>((resolve) => {
    releaseRevalidate = resolve;
  });
  let routedOnce = false;
  await page.route(`**/api/projects/${PROJECT_ID}/issues*`, async (route) => {
    if (routedOnce) {
      await route.continue();
      return;
    }
    routedOnce = true;
    await revalidateHeld;
    await route.continue();
  });

  await refreshButton(page).click();

  // S002-O01: while the background refetch is in flight, the badge reads
  // "revalidating".
  await expect(
    cacheBadge(page),
    `S002-O01 (TC-001, slices ${OWNING_SLICES}): the cache-state badge must read "revalidating" while the background revalidation is in flight, got "${await cacheBadge(page).textContent()}"`,
  ).toHaveAttribute("data-state", "revalidating");
  // S002-O03 (in flight): existing rows remain visible during revalidation (no
  // skeleton/loading flash).
  await expectRefsVisible(
    page,
    "S002-O03 rows stay visible during revalidation (no skeleton flash)",
  );

  // Release the held background request so revalidation completes. The route
  // handler stays registered; subsequent requests fall through its
  // `route.continue()` pass-through branch, so we never abort the in-flight
  // request by unrouting it mid-await.
  releaseRevalidate?.();

  // S002-O02: on completion the badge returns to "warm" and the last-updated
  // time resets to "just now".
  await expect(
    lastUpdated(page),
    `S002-O02 (TC-001, slices ${OWNING_SLICES}): after revalidation the last-updated indicator must read "updated just now", got "${await lastUpdated(page).textContent()}"`,
  ).toHaveText("updated just now");
  await expect(
    cacheBadge(page),
    `S002-O02 (TC-001, slices ${OWNING_SLICES}): the cache-state badge must return to "warm" after revalidation, got "${await cacheBadge(page).textContent()}"`,
  ).toHaveAttribute("data-state", "warm");
  // S002-O03 (after): fresh data is swapped in without a skeleton flash; the
  // rows remain present after the swap.
  await expectRefsVisible(page, "S002-O03 fresh data swapped in without a skeleton flash");

  // S003 (on-disk cache file). Read the persisted snapshot file through the
  // ROUBO_E2E-gated harness route and assert its mode is exactly 0600 and the
  // parsed JSON carries no credential or token fields.
  const cacheFile = await readCutListCacheFile(request, { projectId: PROJECT_ID });
  // S003-O01: file mode is 0600 (owner read/write only, no group or world bits).
  expect(
    cacheFile.mode,
    `S003-O01 (TC-001, slices ${OWNING_SLICES}): the on-disk snapshot file mode must be exactly 0600, got 0${cacheFile.mode.toString(8)} (path ${cacheFile.path})`,
  ).toBe(0o600);
  // S003-O02: content is parseable JSON containing no credential or token fields.
  const serialised = JSON.stringify(cacheFile.content).toLowerCase();
  for (const forbidden of ["token", "credential", "password", "secret", "apikey", "api_key"]) {
    expect(
      serialised.includes(forbidden),
      `S003-O02 (TC-001, slices ${OWNING_SLICES}): the on-disk snapshot JSON must contain no credential or token fields, but found "${forbidden}" (path ${cacheFile.path})`,
    ).toBe(false);
  }
});
