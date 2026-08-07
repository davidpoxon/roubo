import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  loadAppShell,
  readSpecWorkUnits,
  registerFixtureProject,
  resetWithScenario,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  SATCA_TC033_BLOCKING_CASE_ID,
  SATCA_TC033_GATE_ID,
  SATCA_TC033_GATE_MILESTONE,
  SATCA_TC033_OWNING_SLICES,
  SATCA_TC033_PASSED_CASE_ID,
  SATCA_TC033_PLAN,
  SATCA_TC033_RETIRE_REASON,
  SATCA_TC033_SPEC_SLUG,
  SATCA_TC033_WORK_UNITS,
} from "./_support/testbench-plan.js";

// E2E (#777): the integrated drift guard for the VERIFY-GATE release journey
// (SATCA-TC-033, SATCA-FR-008/FR-011, SATCA-US-003). It runs against the BUILT app
// and proves what neither the evaluator's unit tests nor the write path's own
// tests can prove alone: retiring the single case that was holding a gate pending
// releases the gate, the gate view says WHY, and the externally-authored
// work-units.json is never touched to achieve it.
//
// Steps mirror SATCA-TC-033 one for one:
//   S001 opens the gate view and notes the reported state and the unresolved case,
//   S002 retires that case with a reason,
//   S003 returns to the gate view.
//
// The precondition ("a gate reporting pending, held only by one case that has
// never been started") is built for real rather than stubbed: the fixture spec
// declares a gate over two L1 cases, the journey marks one passed through the
// app, and leaves the other untouched, so the gate is held by exactly one
// never-started case. The gate must declare that second, already-passed case:
// retiring the ONLY declared case would empty the gating set, and an empty set is
// deliberately `no_gating_cases` rather than a pass (#436, VG-NFR-007), which is
// not what the case says happens.
//
// Each assertion carries the owning slice from this unit's blocked-by set via
// SATCA_TC033_OWNING_SLICES, so an integrated failure is attributable to a slice
// rather than to "the journey" (the issue's AC7 failure-output contract).
//
// Out of scope, deliberately: any single slice's internals. The rollup and panel
// half of this unit is rollup-panel-retire-journey.spec.ts (SATCA-TC-020).

const SCENARIO = "default";
const NOW = "2026-07-12T09:00:00.000Z";
const PROJECT_ID = "satca-tc-033-gate-release";

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), `${SATCA_TC033_OWNING_SLICES.enable}: read settings`).toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(
    res.status(),
    `${SATCA_TC033_OWNING_SLICES.enable}: PUT /api/settings testBench.enabled`,
  ).toBe(200);
}

async function createSpecBoundBench(page: Page, projectId: string): Promise<number> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText("Bench 1")).toBeVisible();

  await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
  await page.getByRole("button", { name: "Create a TestBench" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  await expect(
    dialog,
    `${SATCA_TC033_OWNING_SLICES.create}: spec-picker modal opens`,
  ).toBeVisible();
  await dialog.getByRole("radio", { name: new RegExp(`^${SATCA_TC033_SPEC_SLUG}`) }).click();
  await dialog.getByRole("button", { name: "Create TestBench" }).click();
  await expect(dialog, `${SATCA_TC033_OWNING_SLICES.create}: modal closes on Create`).toBeHidden();
  await expect(
    page,
    `${SATCA_TC033_OWNING_SLICES.create}: navigates to the new bench's detail view`,
  ).toHaveURL(new RegExp(`/projects/${projectId}/benches/\\d+$`));

  const match = page.url().match(/\/benches\/(\d+)$/);
  const benchId = match ? Number(match[1]) : Number.NaN;
  expect(
    Number.isInteger(benchId),
    `${SATCA_TC033_OWNING_SLICES.create}: bench id resolvable from the URL`,
  ).toBe(true);
  return benchId;
}

async function openTestBenchTab(page: Page): Promise<void> {
  await page
    .getByRole("tablist")
    .getByRole("tab", { name: /^TestBench/ })
    .click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
}

// Switch the open TestBench panel to the verify-gate "Batches" surface, the
// sibling of `showTestBenchCasesView`. Idempotent: a no-op when Batches is
// already the active segment.
async function showTestBenchBatchesView(page: Page): Promise<void> {
  const batches = page.getByRole("tabpanel").getByRole("button", { name: "Batches", exact: true });
  if ((await batches.getAttribute("aria-pressed")) !== "true") {
    await batches.click();
  }
  await expect(batches, "TestBench Batches view is active").toHaveAttribute("aria-pressed", "true");
}

// Open the seeded gate's batch view from the Batches overview and return its
// gate-state panel.
async function openGateView(page: Page) {
  const panel = page.getByRole("tabpanel");
  await panel.getByRole("button", { name: `Open gate ${SATCA_TC033_GATE_ID}` }).click();
  const gatePanel = panel.getByTestId("gate-state-panel");
  await expect(
    gatePanel,
    `${SATCA_TC033_OWNING_SLICES.gateView}: the gate view shows the gate's state panel`,
  ).toBeVisible();
  return gatePanel;
}

// Mark a case's single observation from the Cases review. Same shape as the
// sibling journeys' helper: React Aria's Radio is a <label> hosting the press
// responder, so the visible text is the click target.
async function markCase(page: Page, caseId: string, result: "pass" | "fail"): Promise<void> {
  const panel = page.getByRole("tabpanel");
  await panel.getByTestId("case-row").filter({ hasText: caseId }).click();
  const group = panel.getByRole("radiogroup", { name: /^Mark observation pass or fail:/ });
  const label = result === "pass" ? "Pass" : "Fail";
  await group.getByText(label, { exact: true }).click();
  await expect(
    group.getByRole("radio", { name: label }),
    `${SATCA_TC033_OWNING_SLICES.marks}: ${caseId} marked ${result}`,
  ).toBeChecked();
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("SATCA-TC-033: retiring the only blocking case releases a pending gate", async ({
  page,
  request,
}) => {
  let benchId = 0;
  // The work-units.json bytes before anything is retired, compared after the gate
  // has flipped to passed (S003-O03).
  let workUnitsBefore: { raw: string | null; checksum: string | null } = {
    raw: null,
    checksum: null,
  };

  await test.step("Precondition: enable the TestBench feature", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project whose spec declares a verify gate over two live cases", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions on Create. The
      // gate reads its work-units.json from the PROJECT repo and its plan/results
      // from the bench's worktree (#432), so both copies matter.
      gitInit: true,
      seedSpecs: [
        {
          slug: SATCA_TC033_SPEC_SLUG,
          testCases: SATCA_TC033_PLAN,
          workUnits: SATCA_TC033_WORK_UNITS,
        },
      ],
    });
    expect(projectId).toBe(PROJECT_ID);

    workUnitsBefore = await readSpecWorkUnits(request, {
      projectId: PROJECT_ID,
      slug: SATCA_TC033_SPEC_SLUG,
    });
    expect(
      workUnitsBefore.raw,
      `${SATCA_TC033_OWNING_SLICES.workUnitsUntouched}: the spec carries a work-units.json to gate on`,
    ).not.toBeNull();
  });

  await loadAppShell(page);

  await test.step("Precondition: create a spec-bound TestBench and verify one of the two gating cases", async () => {
    benchId = await createSpecBoundBench(page, PROJECT_ID);
    await openTestBenchTab(page);
    await showTestBenchCasesView(page);
    // Only the first case is marked. The second is never started, which is the
    // precondition's "held only by one case that has never been started".
    await markCase(page, SATCA_TC033_PASSED_CASE_ID, "pass");
  });

  // ── S001: open the gate view, note the state and the unresolved case ─────────
  await test.step("S001-O01: the gate reports pending and names the case", async () => {
    await showTestBenchBatchesView(page);
    const panel = page.getByRole("tabpanel");
    const card = panel.getByTestId("gate-card");
    await expect(
      card,
      `${SATCA_TC033_OWNING_SLICES.batches}: the seeded gate is listed on the Batches overview`,
    ).toContainText(SATCA_TC033_GATE_MILESTONE);

    const gatePanel = await openGateView(page);
    await expect(
      gatePanel,
      `${SATCA_TC033_OWNING_SLICES.pending}: the gate reports pending while an unstarted case gates it`,
    ).toContainText("Pending");
    await expect(
      gatePanel,
      `${SATCA_TC033_OWNING_SLICES.namesCase}: the gate names ${SATCA_TC033_BLOCKING_CASE_ID} as unresolved`,
    ).toContainText(SATCA_TC033_BLOCKING_CASE_ID);
    // The already-verified case is NOT what is holding the gate, so it must not be
    // named: otherwise "names the case" would be satisfied by listing everything.
    await expect(
      gatePanel,
      `${SATCA_TC033_OWNING_SLICES.namesCase}: the already-passed ${SATCA_TC033_PASSED_CASE_ID} is not named as unresolved`,
    ).not.toContainText(SATCA_TC033_PASSED_CASE_ID);
  });

  // ── S002: retire that case with a reason ────────────────────────────────────
  await test.step("S002: retire the blocking case with a reason", async () => {
    const panel = page.getByRole("tabpanel");
    await showTestBenchCasesView(page);
    await panel.getByTestId("case-row").filter({ hasText: SATCA_TC033_BLOCKING_CASE_ID }).click();
    await panel.getByTestId("case-retire-open").click();
    await expect(
      panel.getByTestId("case-retire-panel"),
      `${SATCA_TC033_OWNING_SLICES.retireControl}: the retire panel opens on the blocking case`,
    ).toBeVisible();
    await panel.getByTestId("case-retire-reason").fill(SATCA_TC033_RETIRE_REASON);
    await panel.getByTestId("case-retire-submit").click();
    await expect(
      panel.getByTestId(`archived-reason-${SATCA_TC033_BLOCKING_CASE_ID}`),
      `${SATCA_TC033_OWNING_SLICES.retireControl}: the retirement is recorded with its reason`,
    ).toHaveText(SATCA_TC033_RETIRE_REASON);
  });

  // ── S003: return to the gate view ───────────────────────────────────────────
  await test.step("S003: return to the gate view", async () => {
    // A full navigation, so the gate is re-evaluated from disk rather than served
    // from the React Query cache the pending read populated.
    await page.goto(`/projects/${PROJECT_ID}/benches/${benchId}`);
    await openTestBenchTab(page);
    await showTestBenchBatchesView(page);
  });

  await test.step("S003-O01: the gate reports passed", async () => {
    const gatePanel = await openGateView(page);
    await expect(
      gatePanel,
      `${SATCA_TC033_OWNING_SLICES.released}: retiring the only blocking case releases the gate to passed`,
    ).toContainText("Passed");
    await expect(
      gatePanel,
      `${SATCA_TC033_OWNING_SLICES.released}: the released gate is no longer pending`,
    ).not.toContainText("Pending");
  });

  await test.step("S003-O02: the gate view states that the case was excluded by lifecycle", async () => {
    const excluded = page.getByRole("tabpanel").getByTestId("gate-lifecycle-excluded");
    await expect(
      excluded,
      `${SATCA_TC033_OWNING_SLICES.excludedStated}: the gate view states the lifecycle exclusion in words`,
    ).toBeVisible();
    await expect(
      excluded,
      `${SATCA_TC033_OWNING_SLICES.excludedStated}: the exclusion names ${SATCA_TC033_BLOCKING_CASE_ID}`,
    ).toContainText(SATCA_TC033_BLOCKING_CASE_ID);
    await expect(
      excluded,
      `${SATCA_TC033_OWNING_SLICES.resolver}: the exclusion is attributed to lifecycle, not to colour or to a bare count`,
    ).toContainText("Excluded by lifecycle");
  });

  await test.step("S003-O03: no work unit file was edited to achieve this", async () => {
    const after = await readSpecWorkUnits(request, {
      projectId: PROJECT_ID,
      slug: SATCA_TC033_SPEC_SLUG,
    });
    // Byte-identical, not merely equivalent: the gate narrows its declared set at
    // READ time from the case lifecycle and never writes the narrowing back.
    expect(
      after.checksum,
      `${SATCA_TC033_OWNING_SLICES.workUnitsUntouched}: work-units.json checksum is unchanged by the release`,
    ).toBe(workUnitsBefore.checksum);
    expect(
      after.raw,
      `${SATCA_TC033_OWNING_SLICES.workUnitsUntouched}: work-units.json bytes are unchanged by the release`,
    ).toBe(workUnitsBefore.raw);
    // And the declared gating set still names BOTH cases, including the retired one.
    const units = (
      after.workUnits as { units: { id: string; implements: { test_case_ids: string[] } }[] }
    ).units;
    const gate = units.find((u) => u.id === SATCA_TC033_GATE_ID);
    expect(
      gate?.implements.test_case_ids,
      `${SATCA_TC033_OWNING_SLICES.workUnitsUntouched}: the gate still declares the retired case; only the effective set narrowed`,
    ).toEqual([SATCA_TC033_PASSED_CASE_ID, SATCA_TC033_BLOCKING_CASE_ID]);
  });
});
