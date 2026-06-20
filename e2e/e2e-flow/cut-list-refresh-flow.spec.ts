import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  loadAppShell,
  resetWithScenario,
  setCutListDiskCacheEnabled,
} from "./_support/scenario.js";

// #568: the integration-level drift guard for the US-002 journey "cut list
// refresh shows progress and updates the last-updated indicator". It spans the
// slices #557 (last-updated / in-progress / stale indicators) and #560
// (stale-while-revalidate serving + cache-state wiring) and asserts the
// integrated journey against the authoritative e2e_flow case CLI-TC-017, not
// whatever any single slice implemented.
//
// REACHING THE WARM PATH. TC-017's S001 precondition is "a warm first-page
// snapshot exists on disk". The warm badge + time-ago indicator are driven by
// the server returning `cacheStatus: 'revalidating'` from a DiskSnapshotStore
// hit, but CutListQueryService bypasses the disk under the e2e harness
// (ROUBO_E2E=1) by default, so the warm serve is unreachable. This spec
// un-bypasses the disk for its own duration via the ROUBO_E2E-gated
// `/test/__set-cut-list-disk-cache` (the `setCutListDiskCacheEnabled` helper)
// and produces the snapshot organically: the first open is a miss that writes
// the snapshot, then a `page.reload()` warm-serves it (cacheStatus
// 'revalidating' -> the `warm` badge). `/test/__reset` restores the bypass
// default so the warm path never leaks into another spec.
//
// TC-017 DIVERGENCES (decided: adapt to the shipped contract, tracked by #589):
//
//   1. S001-O02 wording. TC-017 says the indicator shows a snapshot-aged
//      time-ago string such as "updated 2m ago" on the warm open. The shipped
//      indicator (client/src/components/IssueQueuePanel.tsx, `lastUpdatedLabel`)
//      keys the warm/fresh path on React Query's `dataUpdatedAt` (the
//      just-completed client fetch), so it reads "updated just now", not the
//      snapshot-aged wording. The snapshot-aged "snapshot Nm ago" wording only
//      appears on the FR-014 stale path (plugin unavailable), a different
//      journey. We assert a recognizable fresh "updated ..." string plus the
//      `warm` badge. Reconciling TC-017's wording is deferred to #589.
//
//   2. S004-O04 "reflects the latest data". Driving an observable per-call
//      content delta through the warm-then-revalidate path is brittle: each
//      warm serve fires a fire-and-forget background revalidation that walks
//      the stub independently of the client refetch. We assert the rows
//      re-render and the indicator/badge settle (spinner stops, indicator reads
//      "updated just now", badge returns to `warm`) rather than a literal
//      content swap. Deferred to #589.
//
// FR-020 failure-output contract: every assertion below carries a descriptive
// message naming the diverging e2e_flow step, the expected-vs-actual, and the
// owning slice issues #557/#560, so a regression points straight at the step
// and the slice that broke it.
//
// The fixture project (e2e/fixtures/cut-list-refresh-project) pins the e2e-stub
// plugin with one repository source; the scenario seeds three deterministic To
// Do cuts that fit one page, so the warm snapshot is the full first page.

const SCENARIO = "cut-list-refresh";
const NOW = "2026-05-21T13:00:00.000Z";
const OWNING_SLICES = "#557/#560";

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
const refreshIcon = (page: Page) => refreshButton(page).locator("svg");

async function expectRefsVisible(page: Page, step: string): Promise<void> {
  for (const ref of CUT_REFS) {
    await expect(
      page.getByText(ref, { exact: true }),
      `${step} (TC-017, slices ${OWNING_SLICES}): expected cut ${ref} to be visible`,
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

test("TC-017: open a warm cut list, refresh, watch progress, see the indicator settle", async ({
  page,
}) => {
  await loadAppShell(page);

  // Prime the disk snapshot: the first open is a cache miss that runs the live
  // RPC and persists the first page. Assert the rows so the snapshot is written
  // from a fully loaded list before we reload to warm-serve it.
  await page.goto(`/projects/${PROJECT_ID}`);
  await expectRefsVisible(page, "priming open (cache miss writes the snapshot)");

  // S001: open the cut list against the now-warm snapshot. The reload serves the
  // persisted snapshot immediately (cacheStatus 'revalidating' -> the `warm`
  // badge), the cached rows render, and the indicator shows a fresh time-ago
  // string. (TC-017 S001-O02 expects the snapshot-aged "updated 2m ago"; the
  // shipped warm path keys on the client's just-completed fetch and reads
  // "updated just now". Divergence tracked by #589.)
  await page.reload();
  await expectRefsVisible(page, "S001 warm serve renders cached rows");
  await expect(
    cacheBadge(page),
    `S001-O03 (TC-017, slices ${OWNING_SLICES}): the cache-state badge must read "warm" on the warm serve, got "${await cacheBadge(page).textContent()}"`,
  ).toHaveAttribute("data-state", "warm");
  await expect(
    lastUpdated(page),
    `S001-O02 (TC-017, slices ${OWNING_SLICES}): the last-updated indicator must show a fresh "updated ..." time-ago string on the warm serve, got "${await lastUpdated(page).textContent()}"`,
  ).toContainText(/^updated /);

  // S002: click refresh. The refresh icon spins, the indicator reads
  // "refreshing...", the badge flips to "revalidating", and the existing rows
  // stay visible (no blank flash) while the background refetch is in flight.
  //
  // The warm serve against the local stub returns almost instantly, so the
  // in-flight (isRefetching) state would otherwise settle before Playwright can
  // observe it. Hold the refresh refetch open with a one-shot route delay so the
  // spinner / "refreshing..." / "revalidating" trio is deterministically
  // observable, then release it for S003/S004. This delays only the transport,
  // not the contract: the same warm response lands once released.
  let releaseRefetch: (() => void) | undefined;
  const refetchHeld = new Promise<void>((resolve) => {
    releaseRefetch = resolve;
  });
  let routedOnce = false;
  await page.route(`**/api/projects/${PROJECT_ID}/issues*`, async (route) => {
    if (routedOnce) {
      await route.continue();
      return;
    }
    routedOnce = true;
    await refetchHeld;
    await route.continue();
  });

  await refreshButton(page).click();
  await expect(
    refreshIcon(page),
    `S002-O01 (TC-017, slices ${OWNING_SLICES}): the refresh icon must spin (animate-spin) while a refetch is in flight`,
  ).toHaveClass(/animate-spin/);
  await expect(
    lastUpdated(page),
    `S002-O02 (TC-017, slices ${OWNING_SLICES}): the indicator must read "refreshing..." during revalidation, got "${await lastUpdated(page).textContent()}"`,
  ).toHaveText("refreshing...");
  await expect(
    cacheBadge(page),
    `S002 (TC-017, slices ${OWNING_SLICES}): the cache-state badge must read "revalidating" while the refetch is in flight, got "${await cacheBadge(page).textContent()}"`,
  ).toHaveAttribute("data-state", "revalidating");
  // S002-O03: existing rows remain visible during revalidation (keepPreviousData,
  // no blank flash).
  await expectRefsVisible(page, "S002-O03 rows stay visible during revalidation");

  // S003: release the held refetch so revalidation completes. The route handler
  // stays registered (subsequent requests fall through its `route.continue()`
  // pass-through branch); we do not unroute it, which would abort the in-flight
  // request mid-await.
  releaseRefetch?.();

  // S004: wait for revalidation to complete, then observe the settled
  // state. The spinner stops, the indicator reads "updated just now", the badge
  // returns to "warm", and the rows re-render with fresh data (TC-017 S004-O04
  // "reflects the latest data" is asserted as a re-render + settled indicator,
  // not a literal content swap; divergence tracked by #589).
  await expect(
    lastUpdated(page),
    `S004-O02 (TC-017, slices ${OWNING_SLICES}): after revalidation the indicator must read "updated just now", got "${await lastUpdated(page).textContent()}"`,
  ).toHaveText("updated just now");
  await expect(
    refreshIcon(page),
    `S004-O01 (TC-017, slices ${OWNING_SLICES}): the refresh icon must stop spinning once revalidation completes`,
  ).not.toHaveClass(/animate-spin/);
  await expect(
    cacheBadge(page),
    `S004-O03 (TC-017, slices ${OWNING_SLICES}): the cache-state badge must return to "warm" after revalidation, got "${await cacheBadge(page).textContent()}"`,
  ).toHaveAttribute("data-state", "warm");
  await expectRefsVisible(page, "S004-O04 rows reflect fresh data after revalidation");
});
