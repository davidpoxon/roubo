import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  loadAppShell,
  readTestResults,
  registerFixtureProject,
  resetWithScenario,
  rewriteSpecTestCases,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  TC_043_OWNING_SLICES,
  TC_043_PLAN,
  TC_043_PLAN_AFTER_EDIT,
  TESTBENCH_SPEC_SLUG,
} from "./_support/testbench-plan.js";

// E2E (#440): the authoritative `e2e_flow` drift guard for the
// "persist results -> detect staleness -> reconcile without data loss" journey
// (TC-043, US-008/US-009, FR-014/FR-015/FR-016/FR-017, NFR-003). It walks the
// integrated system end to end against the BUILT app: create a spec-bound
// TestBench through the real empty-slot create flow, record marks + a note,
// reload to prove they persist, edit the source plan (remove a case, add a case),
// observe the amber staleness banner, open the reconcile dialog, apply
// "keep orphans", and finally read the on-disk sidecar to prove the archived
// case (with its mark + note) survived and the source plan's checksum is
// unchanged.
//
// Unlike the per-slice unit tests (#406/#407/#412/#413/#415/#416/#422 own those),
// this asserts the JOURNEY, not any single slice's implementation. Each leg is
// wrapped in a labelled `test.step` so a failure localises the diverging step,
// reports the expected-vs-actual at that step, and names the owning slice(s)
// (FR-020 / AC7) via TC_043_OWNING_SLICES.
//
// The mid-test plan edit (remove TC-B, add TC-D) is driven through the
// ROUBO_E2E-gated `/test/__rewrite-spec-cases` harness endpoint, because the
// create-a-TestBench UI exposes no plan editor. As of #493 the endpoint resolves
// the focused spec's `.specifications/<slug>/test-cases.json` from the bench's own
// worktree (bench.workspacePath) the same way the live TestBench routes do, so the
// next plan load detects staleness against the rewritten source.

const SCENARIO = "default";
const NOW = "2026-06-08T09:00:00.000Z";
const PROJECT_ID = "tc-043-persist-reconcile";

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), TC_043_OWNING_SLICES.enable).toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(res.status(), `${TC_043_OWNING_SLICES.enable}: PUT /api/settings testBench.enabled`).toBe(
    200,
  );
}

async function createSpecBoundBench(page: Page, projectId: string): Promise<number> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText("Bench 1")).toBeVisible();

  // Empty-slot menu -> Create a TestBench -> select the seeded spec -> Create.
  await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
  await page.getByRole("button", { name: "Create a TestBench" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  await expect(dialog, `${TC_043_OWNING_SLICES.create}: spec-picker modal opens`).toBeVisible();
  const specRow = dialog.getByRole("radio", { name: new RegExp(`^${TESTBENCH_SPEC_SLUG}`) });
  await specRow.click();
  await dialog.getByRole("button", { name: "Create TestBench" }).click();
  await expect(dialog, `${TC_043_OWNING_SLICES.create}: modal closes on Create`).toBeHidden();
  await expect(
    page,
    `${TC_043_OWNING_SLICES.create}: navigates to the new bench's detail view`,
  ).toHaveURL(new RegExp(`/projects/${projectId}/benches/\\d+$`));

  // The created bench id (first bench => 1) is needed for the harness reads/writes.
  const url = page.url();
  const match = url.match(/\/benches\/(\d+)$/);
  const benchId = match ? Number(match[1]) : Number.NaN;
  expect(
    Number.isInteger(benchId),
    `${TC_043_OWNING_SLICES.create}: bench id resolvable from the URL`,
  ).toBe(true);
  return benchId;
}

// Open a case's detail pane by clicking its row, mark its single observation, and
// wait for the mark to round-trip (the segment renders aria-checked once set).
async function markCase(page: Page, caseId: string, result: "pass" | "fail"): Promise<void> {
  const panel = page.getByRole("tabpanel");
  await panel.getByTestId("case-row").filter({ hasText: caseId }).click();
  // The case detail pane opens with one observation mark control (a RadioGroup
  // whose accessible name starts with "Mark observation pass or fail:"). Only one
  // case detail is open at a time, so the group is unambiguous within the panel.
  const group = panel.getByRole("radiogroup", { name: /^Mark observation pass or fail:/ });
  const label = result === "pass" ? "Pass" : "Fail";
  // React Aria's Radio is a <label> hosting the press responder with a hidden
  // native input; the visible "Pass"/"Fail" text is the click target. Clicking
  // the role=radio input directly does not fire the press handler, so target the
  // label text and assert the underlying radio becomes checked.
  await group.getByText(label, { exact: true }).click();
  await expect(
    group.getByRole("radio", { name: label }),
    `${TC_043_OWNING_SLICES.marks}: ${caseId} marked ${result}`,
  ).toBeChecked();
}

// Resolve the case-detail notes surface, returning the "Notes" complementary
// landmark (the same `<aside aria-label="Notes">` in both layouts). As of #524
// the detail pane gates the notes between an inline side rail and a bottom
// drawer on the pane's own measured width, not the viewport: at this test's
// 1280px Desktop Chrome viewport the projects sidebar and case list leave the
// detail pane below the rail threshold, so the notes live behind the "Notes (n)"
// drawer toggle. Open that toggle when the inline rail is absent, then hand back
// the now-rendered landmark so callers locate the textbox/notes the same way in
// either layout.
async function openCaseNotes(panel: ReturnType<Page["getByRole"]>) {
  const notes = panel.getByRole("complementary", { name: "Notes" });
  if (!(await notes.isVisible())) {
    await panel.getByRole("button", { name: /^Notes \(/ }).click();
    await expect(notes).toBeVisible();
  }
  return notes;
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TC-043: persist results, detect staleness, reconcile without data loss", async ({
  page,
  request,
}) => {
  let benchId = 0;
  // Captured immediately after the Step-3 plan edit (before reconcile), then
  // compared after Apply to prove reconcile never rewrites the source plan (AC5).
  let sourceChecksumAfterEdit = "";

  // ── Preconditions: feature enabled, project with the three-case spec, a real
  // spec-bound TestBench created through the UI ───────────────────────────────
  await test.step("Precondition: enable the TestBench feature (#414)", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying the TC-043 spec", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      gitInit: true,
      seedSpecs: [{ slug: TESTBENCH_SPEC_SLUG, testCases: TC_043_PLAN }],
    });
    expect(projectId).toBe(PROJECT_ID);
  });

  await loadAppShell(page);

  await test.step("Precondition: create a spec-bound TestBench via the empty-slot flow", async () => {
    benchId = await createSpecBoundBench(page, PROJECT_ID);
  });

  await test.step("Precondition: open the TestBench tab with the three seeded cases", async () => {
    await page.getByRole("tab", { name: /^TestBench/ }).click();
    const panel = page.getByRole("tabpanel");
    // The view toggle now opens on the "Batches" surface by default (#359);
    // switch to the Cases review this journey asserts on (overall rollup +
    // cases + recorded marks). The choice is remembered per bench, so the later
    // TestBench-tab visits in this spec stay on Cases without re-switching.
    await showTestBenchCasesView(page);
    await expect(panel.getByText("Overall"), TC_043_OWNING_SLICES.reviewPanel).toBeVisible();
    for (const id of ["TC-A", "TC-B", "TC-C"]) {
      await expect(
        panel.getByTestId("case-row").filter({ hasText: id }),
        `${TC_043_OWNING_SLICES.reviewPanel}: ${id} is listed`,
      ).toBeVisible();
    }
  });

  // ── Step 1: record marks + a note (TC-A pass, TC-B fail + note, TC-C pass) ──
  await test.step("Step 1: mark TC-A pass, TC-B fail with a note, TC-C pass (#412/#415)", async () => {
    await markCase(page, "TC-A", "pass");

    // TC-B: fail + a note via the case detail's notes rail.
    await markCase(page, "TC-B", "fail");
    const notes = await openCaseNotes(page.getByRole("tabpanel"));
    await notes.getByRole("textbox").fill("broken redirect");
    await notes.getByRole("button", { name: "Add note" }).click();
    await expect(
      notes.getByText("broken redirect"),
      `${TC_043_OWNING_SLICES.notes}: TC-B note appended`,
    ).toBeVisible();

    await markCase(page, "TC-C", "pass");
  });

  // ── Step 2: reload the tab -> the marks + note persist beside the spec (AC1) ─
  await test.step("Step 2: reload the tab and assert all three results persist (AC1, #406/#415)", async () => {
    await page.reload();
    await page.getByRole("tab", { name: /^TestBench/ }).click();
    const panel = page.getByRole("tabpanel");

    // TC-A and TC-C show passed in the list; TC-B shows failed.
    await expect(
      panel.getByTestId("case-row").filter({ hasText: "TC-A" }).getByText("Passed"),
      `${TC_043_OWNING_SLICES.persist}: TC-A persisted as passed`,
    ).toBeVisible();
    await expect(
      panel.getByTestId("case-row").filter({ hasText: "TC-C" }).getByText("Passed"),
      `${TC_043_OWNING_SLICES.persist}: TC-C persisted as passed`,
    ).toBeVisible();
    await expect(
      panel.getByTestId("case-row").filter({ hasText: "TC-B" }).getByText("Failed"),
      `${TC_043_OWNING_SLICES.persist}: TC-B persisted as failed`,
    ).toBeVisible();

    // The TC-B note survived the reload (read from the detail pane's notes rail).
    await panel.getByTestId("case-row").filter({ hasText: "TC-B" }).click();
    const notes = await openCaseNotes(panel);
    await expect(
      notes.getByText("broken redirect"),
      `${TC_043_OWNING_SLICES.persist}: TC-B note persisted across reload`,
    ).toBeVisible();
  });

  // ── Step 3: edit the source plan (remove TC-B, add TC-D); banner appears (AC2) ─
  await test.step("Step 3: edit the plan (remove TC-B, add TC-D); the staleness banner appears (AC2, #407/#422)", async () => {
    await rewriteSpecTestCases(request, {
      projectId: PROJECT_ID,
      benchId,
      testCases: TC_043_PLAN_AFTER_EDIT,
    });
    // Navigate away and back so the plan query refetches against the new source.
    await page.goto(`/projects/${PROJECT_ID}/benches/${benchId}`);
    await page.getByRole("tab", { name: /^TestBench/ }).click();
    await expect(
      page.getByTestId("staleness-banner"),
      `${TC_043_OWNING_SLICES.staleness}: amber staleness banner appears after the plan edit`,
    ).toBeVisible();
    // Capture the source plan checksum NOW (post-edit, pre-reconcile) so Step 6
    // can prove the reconcile Apply did not rewrite it (AC5).
    const postEdit = await readTestResults(request, { projectId: PROJECT_ID, benchId });
    sourceChecksumAfterEdit = postEdit.casesChecksum;
  });

  // ── Step 4: open reconcile -> TC-D Added, TC-B Orphaned with mark + note (AC3) ─
  await test.step("Step 4: open reconcile; TC-D is Added and TC-B is Orphaned (AC3, #413/#422)", async () => {
    await page.getByTestId("staleness-banner-reconcile").click();
    const added = page.getByTestId("reconcile-section-added");
    const orphan = page.getByTestId("reconcile-section-orphan");
    await expect(
      added.getByText("TC-D"),
      `${TC_043_OWNING_SLICES.reconcile}: TC-D listed under Added`,
    ).toBeVisible();
    await expect(
      orphan.getByText("TC-B"),
      `${TC_043_OWNING_SLICES.reconcile}: TC-B listed under Orphaned`,
    ).toBeVisible();
    await expect(
      page.getByTestId("reconcile-section-orphan-count"),
      `${TC_043_OWNING_SLICES.reconcile}: exactly one orphan`,
    ).toHaveText("1");
  });

  // ── Step 5: Apply (keep orphans) -> active cases keep marks, TC-B archived (AC4) ─
  await test.step("Step 5: apply 'keep orphans'; TC-A/TC-C active with marks, TC-D no mark, TC-B archived, banner clears (AC4, #413/#422)", async () => {
    await page.getByTestId("reconcile-apply").click();
    const panel = page.getByRole("tabpanel");

    // The banner clears once the stored hash matches the rewritten plan.
    await expect(
      page.getByTestId("staleness-banner"),
      `${TC_043_OWNING_SLICES.apply}: banner clears after Apply`,
    ).toBeHidden();

    // TC-A / TC-C remain active with their pass marks; TC-D is active with no mark.
    await expect(
      panel.getByTestId("case-row").filter({ hasText: "TC-A" }).getByText("Passed"),
      `${TC_043_OWNING_SLICES.apply}: TC-A still active and passed`,
    ).toBeVisible();
    await expect(
      panel.getByTestId("case-row").filter({ hasText: "TC-C" }).getByText("Passed"),
      `${TC_043_OWNING_SLICES.apply}: TC-C still active and passed`,
    ).toBeVisible();
    await expect(
      panel.getByTestId("case-row").filter({ hasText: "TC-D" }).getByText("Not started"),
      `${TC_043_OWNING_SLICES.apply}: TC-D active with no mark`,
    ).toBeVisible();

    // TC-B is no longer in the active list; it appears in the archived section
    // with its fail mark and note retained (NFR-003).
    await expect(
      panel.getByTestId("case-row").filter({ hasText: "TC-B" }),
      `${TC_043_OWNING_SLICES.apply}: TC-B no longer in the active case list`,
    ).toHaveCount(0);
    const archivedB = panel.getByTestId("archived-case-TC-B");
    await expect(
      archivedB,
      `${TC_043_OWNING_SLICES.integrity}: TC-B archived and visible`,
    ).toBeVisible();
    await expect(
      archivedB.getByText("fail", { exact: true }),
      `${TC_043_OWNING_SLICES.integrity}: TC-B archived fail mark retained`,
    ).toBeVisible();
    await expect(
      archivedB.getByText("broken redirect"),
      `${TC_043_OWNING_SLICES.integrity}: TC-B archived note retained`,
    ).toBeVisible();

    // The rollup counts only the active plan cases: TC-A/TC-C passed and TC-D
    // not_started (remaining), a denominator of 3. The archived orphan TC-B is
    // excluded from the rollup entirely (AC4: "the rollup counts only TC-A and
    // TC-C"). Assert the ProgressBar's accessible readout, not bare visibility,
    // so the count + orphan-exclusion behaviour AC4 demands is actually proven.
    await expect(
      panel.getByRole("img", {
        name: "Overall: 2 passed, 0 failed, 0 in progress, 1 remaining of 3",
      }),
      `${TC_043_OWNING_SLICES.apply}: rollup counts only the active cases (orphan TC-B excluded)`,
    ).toBeVisible();
  });

  // ── Step 6: read the on-disk sidecar -> archived TC-B retained, source plan
  // checksum unchanged (AC5) ──────────────────────────────────────────────────
  await test.step("Step 6: on-disk results retain archived TC-B and the source plan checksum is unchanged (AC5, NFR-003)", async () => {
    // Snapshot the source plan checksum after the Step-3 edit but as it is now
    // (reconcile must not have rewritten it). We read it again here and compare
    // it to the checksum captured immediately after the edit.
    interface OnDiskCaseResult {
      orphaned?: boolean;
      observationMarks?: Record<string, { result?: string }>;
      notes?: unknown[];
    }
    // v2.0.0 flattened shape (#493): one results file per worktree, so caseResults
    // sits at the file top level with no per-bench `benches` map.
    interface OnDiskResults {
      caseResults: Record<string, OnDiskCaseResult>;
    }

    const after = await readTestResults(request, { projectId: PROJECT_ID, benchId });
    const file = after.results as OnDiskResults | null;
    expect(file, `${TC_043_OWNING_SLICES.integrity}: a results sidecar exists`).not.toBeNull();
    const tcB = file?.caseResults["TC-B"];
    expect(tcB, `${TC_043_OWNING_SLICES.integrity}: TC-B is retained on disk`).toBeTruthy();
    expect(
      tcB?.orphaned,
      `${TC_043_OWNING_SLICES.integrity}: TC-B flagged orphaned, not deleted`,
    ).toBe(true);
    expect(
      tcB?.observationMarks?.["TC-B-S1-O1"]?.result,
      `${TC_043_OWNING_SLICES.integrity}: TC-B fail mark retained on disk`,
    ).toBe("fail");
    expect(
      (tcB?.notes ?? []).length,
      `${TC_043_OWNING_SLICES.integrity}: TC-B note retained on disk`,
    ).toBeGreaterThan(0);

    // The source test-cases.json checksum is unchanged by the reconcile Apply:
    // reconcile only ever writes test-results.json. Compare the current source
    // checksum to the one captured right after the Step-3 edit.
    expect(
      after.casesChecksum,
      `${TC_043_OWNING_SLICES.integrity}: source plan checksum unchanged by reconcile`,
    ).toBe(sourceChecksumAfterEdit);
  });
});
