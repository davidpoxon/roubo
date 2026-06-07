import { expect, test } from "@playwright/test";
import { resetWithScenario } from "./_support/scenario.js";
import { addSource, externalIds, openConfigure, readSources, save } from "./_support/picker.js";

// WU-008 (#357): the source-search-area end-to-end journey for the searchable,
// project-first Jira source picker. This mirrors the single `e2e_flow` case in
// the `source-search` area of `.specifications/jira-sources-scale/test-cases.json`:
//
//   TC-022 find a source by searching instead of scrolling
//
// It shares the e2e-flow harness (`_support/picker.ts`, `_support/scenario.ts`)
// with the picker-area journeys in `jira-picker-flows.spec.ts`, so the whole
// area runs as a single CI suite (the `pr-check` workflow runs `npx playwright
// test`, which includes the `e2e-flow` project).
//
// Scenario: `jira-sources-scale-search` models a large instance, scoping 15
// boards to project PLAT. The stub's `getSourceOptions` pages results in
// windows of 10 (PAGE_SIZE in e2e/fixtures/stubbed-plugin/src/contract.ts), so a
// board search returns a capped first page plus a "Load more" cursor, exercising
// the affordance and the result-count readout TC-022 asserts.

const SCENARIO = "jira-sources-scale-search";
const NOW = "2026-05-21T13:00:00.000Z";

// Mirrors PAGE_SIZE in the stub contract: the page cap that proves the picker
// shows a bounded window, not the whole instance ("no giant pre-loaded list").
const PAGE_SIZE = 10;
// Generous wall-clock budget for scoped results to appear after typing. This is
// a non-flaky smoke proxy for NFR-001, not its hard p95<500ms target: it covers
// the picker's ~250ms input debounce plus the stub RPC with CI headroom. The
// hard latency budget is a metric/perf-harness concern, not an e2e assertion.
const LATENCY_BUDGET_MS = 2_000;

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TC-022: a developer finds a source by searching instead of scrolling", async ({
  page,
  request,
}) => {
  const projectId = "tc-022";
  const { dialog, picker } = await openConfigure(page, request, projectId);

  // Precondition: a project is in scope, which gates and scopes the board search.
  await addSource(page, picker, "projects", { search: "Platform", option: /Platform/ });

  // Step 1 - open a source picker. The board search popover opens with its
  // search field focused (no scrolling a giant list to begin).
  const boardsTrigger = picker.getByRole("button", { name: /^Add boards$/i });
  await boardsTrigger.click();
  const searchbox = page.getByRole("searchbox", { name: /^Search boards$/i });
  await expect(searchbox).toBeFocused();

  // The popover portals to the body, so its results are queried from `page`.
  const results = page.getByRole("listbox", { name: /Boards results/i });
  const resultCount = page.getByTestId("source-search-result-count");

  // ...and no giant pre-loaded list: even with 15 boards in scope the popover
  // shows only one capped page rather than dumping the whole instance.
  await expect(results.getByRole("option")).toHaveCount(PAGE_SIZE);

  // Step 2 - type a few characters. Wait for the debounced search query to
  // settle (its first page carries no cursor) before asserting, so nothing
  // races the picker's ~250ms input debounce: until that query lands it would
  // reset the result list back to page one. Scoped results must arrive within
  // the latency budget.
  const firstPage = page.waitForResponse(
    (r) =>
      r.url().includes("/integration/source-options") &&
      r.url().includes("category=board") &&
      r.url().includes("search=Board") &&
      !r.url().includes("cursor="),
  );
  const started = Date.now();
  await searchbox.fill("Board");
  await firstPage;
  expect(Date.now() - started).toBeLessThan(LATENCY_BUDGET_MS);

  // All 15 boards match "Board", but the first page is capped: 10 results with
  // more available, surfaced as a "Load more" button and a "10+ results" count.
  await expect(results.getByRole("option")).toHaveCount(PAGE_SIZE);
  const loadMore = page.getByRole("button", { name: /Load more/i });
  await expect(loadMore).toBeVisible();
  await expect(resultCount).toHaveText("10+ results");

  // FR-013: the results list renders outside the Configure modal's DOM subtree
  // (portaled to the body), so it can never be clipped by the modal's overflow.
  await expect(dialog.getByRole("listbox", { name: /Boards results/i })).toHaveCount(0);
  await expect(results).toBeVisible();

  // Paging in the rest of the set: wait for the next-page response (it carries
  // the cursor) so the count assertion can't race the fetch. The search has
  // already settled, so no debounced query resets the list back to page one.
  const secondPage = page.waitForResponse(
    (r) => r.url().includes("category=board") && r.url().includes("cursor=10"),
  );
  await loadMore.click();
  await secondPage;
  await expect(results.getByRole("option")).toHaveCount(15);
  await expect(resultCount).toHaveText("15 results");
  // The button is conditionally rendered, so an exhausted set removes it from
  // the DOM entirely rather than hiding it with CSS.
  await expect(loadMore).not.toBeAttached();

  // Step 3 - select a result. The chosen board is added (its chip appears) and
  // persists to the source selection read back through the host endpoint.
  await results.getByRole("option", { name: /Platform Board 03/ }).click();
  await boardsTrigger.click({ force: true });
  await expect(picker.getByRole("button", { name: /^Remove Platform Board 03$/i })).toBeVisible();

  await save(dialog);

  const sources = await readSources(request, projectId);
  expect(externalIds(sources.board)).toEqual(["603"]);
  expect(sources.board?.[0]).toMatchObject({ externalId: "603", project: "PLAT" });
});
