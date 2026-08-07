import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  SATCA_TC020_FAILED_CASE_ID,
  SATCA_TC020_OWNING_SLICES,
  SATCA_TC020_PASSED_CASE_ID,
  SATCA_TC020_PLAN,
  SATCA_TC020_RETIRE_CASE_ID,
  SATCA_TC020_RETIRE_REASON,
  SATCA_TC020_SPEC_SLUG,
  satcaTc020OverallLabel,
} from "./_support/testbench-plan.js";

// E2E (#777): the integrated drift guard for the ROLLUP AND PANEL retirement
// journey (SATCA-TC-020, SATCA-FR-005/FR-006/FR-007, SATCA-US-003/US-011). It runs
// against the BUILT app and proves the thing no single slice can prove on its own:
// the in-app retire write (#772), the rollup's live/non-live partition (#769) and
// the shared live predicate (#766) compose, so retiring a case moves it out of the
// counts and into the archived section, and restoring it puts it back with the
// results it had.
//
// Steps mirror SATCA-TC-020 one for one:
//   S001 notes the rollup totals and the live case count,
//   S002 starts the retire action on a live case and observes that a reason is
//        required and confirmation refused while it is empty,
//   S003 enters a reason and confirms,
//   S004 reverses the retirement from the archived entry.
//
// The retirement is driven through the IN-APP control, not a hand edit of the case
// file: S002's reason-required / empty-refused observation only exists on that
// control, and the file-authored path is SATCA-TC-010's journey (#776), already
// guarded by case-lifecycle-format.spec.ts.
//
// Each assertion carries the owning slice from this unit's blocked-by set via
// SATCA_TC020_OWNING_SLICES, so an integrated failure is attributable to a slice
// rather than to "the journey" (the issue's AC7 failure-output contract).
//
// Out of scope, deliberately: any single slice's internals. The verify gate half
// of this unit is gate-lifecycle-release-journey.spec.ts (SATCA-TC-033).

const SCENARIO = "default";
const NOW = "2026-07-11T09:00:00.000Z";
const PROJECT_ID = "satca-tc-020-rollup-panel";

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), `${SATCA_TC020_OWNING_SLICES.enable}: read settings`).toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(
    res.status(),
    `${SATCA_TC020_OWNING_SLICES.enable}: PUT /api/settings testBench.enabled`,
  ).toBe(200);
}

// Create a spec-bound TestBench through the real empty-slot create flow and
// return its id.
async function createSpecBoundBench(page: Page, projectId: string): Promise<number> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText("Bench 1")).toBeVisible();

  await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
  await page.getByRole("button", { name: "Create a TestBench" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  await expect(
    dialog,
    `${SATCA_TC020_OWNING_SLICES.create}: spec-picker modal opens`,
  ).toBeVisible();
  await dialog.getByRole("radio", { name: new RegExp(`^${SATCA_TC020_SPEC_SLUG}`) }).click();
  await dialog.getByRole("button", { name: "Create TestBench" }).click();
  await expect(dialog, `${SATCA_TC020_OWNING_SLICES.create}: modal closes on Create`).toBeHidden();
  await expect(
    page,
    `${SATCA_TC020_OWNING_SLICES.create}: navigates to the new bench's detail view`,
  ).toHaveURL(new RegExp(`/projects/${projectId}/benches/\\d+$`));

  const match = page.url().match(/\/benches\/(\d+)$/);
  const benchId = match ? Number(match[1]) : Number.NaN;
  expect(
    Number.isInteger(benchId),
    `${SATCA_TC020_OWNING_SLICES.create}: bench id resolvable from the URL`,
  ).toBe(true);
  return benchId;
}

// Open the bench's TestBench tab on the Cases review. The view toggle opens on the
// verify-gate "Batches" surface by default (#359), and this journey reads the
// Overall rollup, the live case list and the archived section.
async function openCasesReview(page: Page): Promise<void> {
  await page
    .getByRole("tablist")
    .getByRole("tab", { name: /^TestBench/ })
    .click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await showTestBenchCasesView(page);
}

// Select a case and mark its single observation, waiting for the mark to
// round-trip (the segment renders aria-checked once set). Same shape as the
// TC-043 journey's helper: React Aria's Radio is a <label> hosting the press
// responder, so the visible text is the click target.
async function markCase(page: Page, caseId: string, result: "pass" | "fail"): Promise<void> {
  const panel = page.getByRole("tabpanel");
  await panel.getByTestId("case-row").filter({ hasText: caseId }).click();
  const group = panel.getByRole("radiogroup", { name: /^Mark observation pass or fail:/ });
  const label = result === "pass" ? "Pass" : "Fail";
  await group.getByText(label, { exact: true }).click();
  await expect(
    group.getByRole("radio", { name: label }),
    `${SATCA_TC020_OWNING_SLICES.marks}: ${caseId} marked ${result}`,
  ).toBeChecked();
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("SATCA-TC-020: retiring from the panel moves a case out of the rollup and into the archived section", async ({
  page,
  request,
}) => {
  await test.step("Precondition: enable the TestBench feature", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying a spec with three live cases", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions on Create. The
      // in-app retire write lands in that worktree, which is where the live
      // TestBench routes read the plan from (#493).
      gitInit: true,
      seedSpecs: [{ slug: SATCA_TC020_SPEC_SLUG, testCases: SATCA_TC020_PLAN }],
    });
    expect(projectId).toBe(PROJECT_ID);
  });

  await loadAppShell(page);

  await test.step("Precondition: create a spec-bound TestBench and confirm all three cases are live", async () => {
    await createSpecBoundBench(page, PROJECT_ID);
    await openCasesReview(page);
    const panel = page.getByRole("tabpanel");
    for (const id of [
      SATCA_TC020_RETIRE_CASE_ID,
      SATCA_TC020_PASSED_CASE_ID,
      SATCA_TC020_FAILED_CASE_ID,
    ]) {
      await expect(
        panel.getByTestId("case-row").filter({ hasText: id }),
        `${SATCA_TC020_OWNING_SLICES.live}: ${id} is live in the case list before any retirement`,
      ).toBeVisible();
    }
    // Nothing is archived yet: absence of a lifecycle block IS the live state.
    await expect(
      panel.getByTestId("archived-cases"),
      `${SATCA_TC020_OWNING_SLICES.live}: no archived section before any lifecycle record exists`,
    ).toHaveCount(0);
  });

  const panel = page.getByRole("tabpanel");
  const overall = panel.getByRole("img", { name: /^Overall:/ });

  await test.step("Precondition: record a result against each live case so the rollup has a contribution to lose", async () => {
    await markCase(page, SATCA_TC020_RETIRE_CASE_ID, "pass");
    await markCase(page, SATCA_TC020_PASSED_CASE_ID, "pass");
    await markCase(page, SATCA_TC020_FAILED_CASE_ID, "fail");
  });

  // ── S001: note the rollup totals and the live case count ─────────────────────
  await test.step("S001: note the rollup totals and the live case count", async () => {
    await expect(
      overall,
      `${SATCA_TC020_OWNING_SLICES.rollup}: the Overall rollup counts all three live cases`,
    ).toHaveAttribute("aria-label", satcaTc020OverallLabel({ passed: 2, failed: 1, total: 3 }));
    await expect(
      panel.getByTestId("case-row"),
      `${SATCA_TC020_OWNING_SLICES.live}: three cases are live`,
    ).toHaveCount(3);
  });

  // ── S002: choose a live case and start the retire action ─────────────────────
  await test.step("S002-O01: starting the retire action requests a reason and refuses confirmation while it is empty", async () => {
    await panel.getByTestId("case-row").filter({ hasText: SATCA_TC020_RETIRE_CASE_ID }).click();
    await panel.getByTestId("case-retire-open").click();
    await expect(
      panel.getByTestId("case-retire-panel"),
      `${SATCA_TC020_OWNING_SLICES.retireControl}: the retire panel opens on the chosen live case`,
    ).toBeVisible();
    await expect(
      panel.getByTestId("case-retire-reason"),
      `${SATCA_TC020_OWNING_SLICES.reasonRequired}: a reason is requested`,
    ).toBeVisible();
    await expect(
      panel.getByTestId("case-retire-submit"),
      `${SATCA_TC020_OWNING_SLICES.reasonRequired}: confirmation is refused while the reason is empty`,
    ).toBeDisabled();
    // Whitespace alone is not a reason either: the guard trims before it decides.
    await panel.getByTestId("case-retire-reason").fill("   ");
    await expect(
      panel.getByTestId("case-retire-submit"),
      `${SATCA_TC020_OWNING_SLICES.reasonRequired}: confirmation is still refused for a blank reason`,
    ).toBeDisabled();
  });

  // ── S003: enter a reason and confirm ─────────────────────────────────────────
  await test.step("S003: enter a reason and confirm the retirement", async () => {
    await panel.getByTestId("case-retire-reason").fill(SATCA_TC020_RETIRE_REASON);
    await expect(
      panel.getByTestId("case-retire-submit"),
      `${SATCA_TC020_OWNING_SLICES.reasonRequired}: confirmation is allowed once a reason is entered`,
    ).toBeEnabled();
    await panel.getByTestId("case-retire-submit").click();
  });

  await test.step("S003-O01: the case leaves the live list", async () => {
    // The two untouched cases are asserted present FIRST: they prove the live list
    // has re-rendered, which is what makes the absence below meaningful rather than
    // vacuously true against a list still in flight.
    for (const id of [SATCA_TC020_PASSED_CASE_ID, SATCA_TC020_FAILED_CASE_ID]) {
      await expect(
        panel.getByTestId("case-row").filter({ hasText: id }),
        `${SATCA_TC020_OWNING_SLICES.live}: the untouched ${id} is still live`,
      ).toBeVisible();
    }
    await expect(
      panel.getByTestId("case-row").filter({ hasText: SATCA_TC020_RETIRE_CASE_ID }),
      `${SATCA_TC020_OWNING_SLICES.excluded}: ${SATCA_TC020_RETIRE_CASE_ID} is gone from the live case list`,
    ).toHaveCount(0);
  });

  await test.step("S003-O02: the rollup denominator and passed count both drop by the case's contribution", async () => {
    // The retired case contributed one pass out of three, so BOTH the passed count
    // and the total fall by exactly one, while the failed count is unmoved.
    await expect(
      overall,
      `${SATCA_TC020_OWNING_SLICES.rollup}: the Overall rollup drops the retired case's pass and its slot in the denominator`,
    ).toHaveAttribute("aria-label", satcaTc020OverallLabel({ passed: 1, failed: 1, total: 2 }));
  });

  await test.step("S003-O03: the case appears in the archived section labelled retired, with the reason", async () => {
    await expect(
      panel.getByTestId("archived-cases"),
      `${SATCA_TC020_OWNING_SLICES.archived}: the archived section is shown once a case is non-live`,
    ).toBeVisible();
    const archived = panel.getByTestId(`archived-case-${SATCA_TC020_RETIRE_CASE_ID}`);
    await expect(
      archived,
      `${SATCA_TC020_OWNING_SLICES.archived}: ${SATCA_TC020_RETIRE_CASE_ID} appears in the archived section`,
    ).toBeVisible();
    // The state is stated in words, not by colour alone (SATCA-FR-003).
    await expect(
      archived,
      `${SATCA_TC020_OWNING_SLICES.resolver}: ${SATCA_TC020_RETIRE_CASE_ID} is labelled Retired`,
    ).toContainText("Retired");
    await expect(
      panel.getByTestId(`archived-reason-${SATCA_TC020_RETIRE_CASE_ID}`),
      `${SATCA_TC020_OWNING_SLICES.reason}: the typed reason is rendered verbatim, not summarised`,
    ).toHaveText(SATCA_TC020_RETIRE_REASON);
    // The write moved the case, so focus follows it to where Restore now sits.
    await expect(
      archived,
      `${SATCA_TC020_OWNING_SLICES.panel}: focus lands on the archived entry the case moved into`,
    ).toBeFocused();
  });

  // ── S004: reverse the retirement from the archived entry ─────────────────────
  await test.step("S004-O01: the case returns to the live list with its recorded results intact", async () => {
    await panel.getByTestId(`archived-restore-${SATCA_TC020_RETIRE_CASE_ID}`).click();

    await expect(
      panel.getByTestId("case-row").filter({ hasText: SATCA_TC020_RETIRE_CASE_ID }),
      `${SATCA_TC020_OWNING_SLICES.restore}: ${SATCA_TC020_RETIRE_CASE_ID} is back in the live case list`,
    ).toBeVisible();
    // The rollup returning to its S001 reading is the direct evidence the recorded
    // PASS survived the round trip: a restored-but-unmarked case would come back as
    // remaining, not as passed.
    await expect(
      overall,
      `${SATCA_TC020_OWNING_SLICES.rollup}: the restored case brings its recorded pass back into the rollup`,
    ).toHaveAttribute("aria-label", satcaTc020OverallLabel({ passed: 2, failed: 1, total: 3 }));
    // The archived section empties out with nothing left to show.
    await expect(
      panel.getByTestId("archived-cases"),
      `${SATCA_TC020_OWNING_SLICES.restore}: the archived section is gone once the last record is cleared`,
    ).toHaveCount(0);
    // And the mark itself is still on the observation, not merely implied by a count.
    await panel.getByTestId("case-row").filter({ hasText: SATCA_TC020_RETIRE_CASE_ID }).click();
    await expect(
      panel
        .getByRole("radiogroup", { name: /^Mark observation pass or fail:/ })
        .getByRole("radio", { name: "Pass" }),
      `${SATCA_TC020_OWNING_SLICES.marks}: the restored case still carries its recorded pass mark`,
    ).toBeChecked();
  });
});
