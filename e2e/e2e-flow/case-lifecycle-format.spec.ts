import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
  rewriteSpecTestCases,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  SATCA_TC010_EDITED_PLAN,
  SATCA_TC010_LIVE_PLAN,
  SATCA_TC010_OWNING_SLICES,
  SATCA_TC010_REPLACEMENT_CASE_ID,
  SATCA_TC010_RETIRE_CASE_ID,
  SATCA_TC010_RETIRED_REASON,
  SATCA_TC010_SPEC_SLUG,
  SATCA_TC010_SUPERSEDE_CASE_ID,
} from "./_support/testbench-plan.js";

// E2E (#776): the integrated drift guard for the case lifecycle FORMAT journey
// (SATCA-TC-010, SATCA-FR-001/FR-002/FR-003, SATCA-US-001/US-002). It runs
// against the BUILT app and proves the one thing no single slice can prove on
// its own: a retirement AUTHORED BY HAND in the spec's case file is read, end to
// end, by the running application.
//
// The case's precondition is "a spec whose cases are all live", so the fixture
// seeds three live cases and the journey applies the lifecycle blocks itself,
// mid-test, into the bench's own worktree via the ROUBO_E2E-gated
// `/test/__rewrite-spec-cases` endpoint (there is no plan editor in the UI, and
// authoring by hand is exactly what S001 and S002 describe). Seeding the plan
// pre-retired would render the same pixels while proving strictly less: this
// ordering asserts the app picked the change up off disk.
//
// Steps mirror SATCA-TC-010 one for one: S001 retires a case with a reason,
// S002 supersedes a second case with a bare pointer at a third (which stays
// live, so the pointer resolves same-spec and present), S003 opens the panel and
// reads it. Each assertion carries the owning slice from this unit's blocked-by
// set (#763, #764, #766, #768, #769, #774, #781) so an integrated failure is
// attributable to a slice rather than to "the journey".
//
// Out of scope, deliberately: any single slice's internals. The in-app retire /
// supersede WRITE path is #772's journey, the spec-level lifecycle is #770/#773's.

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";
const PROJECT_ID = "satca-tc-010-case-lifecycle";

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), `${SATCA_TC010_OWNING_SLICES.enable}: read settings`).toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(
    res.status(),
    `${SATCA_TC010_OWNING_SLICES.enable}: PUT /api/settings testBench.enabled`,
  ).toBe(200);
}

// Create a spec-bound TestBench through the real empty-slot create flow and
// return its id, which the harness plan rewrite addresses.
async function createSpecBoundBench(page: Page, projectId: string): Promise<number> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText("Bench 1")).toBeVisible();

  await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
  await page.getByRole("button", { name: "Create a TestBench" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  await expect(
    dialog,
    `${SATCA_TC010_OWNING_SLICES.create}: spec-picker modal opens`,
  ).toBeVisible();
  await dialog.getByRole("radio", { name: new RegExp(`^${SATCA_TC010_SPEC_SLUG}`) }).click();
  await dialog.getByRole("button", { name: "Create TestBench" }).click();
  await expect(dialog, `${SATCA_TC010_OWNING_SLICES.create}: modal closes on Create`).toBeHidden();
  await expect(
    page,
    `${SATCA_TC010_OWNING_SLICES.create}: navigates to the new bench's detail view`,
  ).toHaveURL(new RegExp(`/projects/${projectId}/benches/\\d+$`));

  const match = page.url().match(/\/benches\/(\d+)$/);
  const benchId = match ? Number(match[1]) : Number.NaN;
  expect(
    Number.isInteger(benchId),
    `${SATCA_TC010_OWNING_SLICES.create}: bench id resolvable from the URL`,
  ).toBe(true);
  return benchId;
}

// Open the bench's TestBench tab on the Cases review. The view toggle opens on
// the verify-gate "Batches" surface by default (#359), and this journey reads
// the live case list and the archived section.
async function openCasesReview(page: Page): Promise<void> {
  await page
    .getByRole("tablist")
    .getByRole("tab", { name: /^TestBench/ })
    .click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await showTestBenchCasesView(page);
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("SATCA-TC-010: a file-authored retirement is read end to end by the application", async ({
  page,
  request,
}) => {
  let benchId = 0;

  await test.step("Precondition: enable the TestBench feature", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying a discoverable spec whose cases are all live", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions on Create.
      // The hand edit lands in that worktree, which is where the live TestBench
      // routes read the plan from (#493).
      gitInit: true,
      seedSpecs: [{ slug: SATCA_TC010_SPEC_SLUG, testCases: SATCA_TC010_LIVE_PLAN }],
    });
    expect(projectId).toBe(PROJECT_ID);
  });

  await loadAppShell(page);

  await test.step("Precondition: create a spec-bound TestBench and confirm all three cases are live", async () => {
    benchId = await createSpecBoundBench(page, PROJECT_ID);
    await openCasesReview(page);
    const panel = page.getByRole("tabpanel");
    for (const id of [
      SATCA_TC010_RETIRE_CASE_ID,
      SATCA_TC010_SUPERSEDE_CASE_ID,
      SATCA_TC010_REPLACEMENT_CASE_ID,
    ]) {
      await expect(
        panel.getByTestId("case-row").filter({ hasText: id }),
        `${SATCA_TC010_OWNING_SLICES.live}: ${id} is live in the case list before any edit`,
      ).toBeVisible();
    }
    // Nothing is archived yet: absence of a lifecycle block IS the live state.
    await expect(
      panel.getByTestId("archived-cases"),
      `${SATCA_TC010_OWNING_SLICES.live}: no archived section before any lifecycle block exists`,
    ).toHaveCount(0);
  });

  // ── S001 + S002: author the lifecycle blocks by hand in the spec's case file ─
  await test.step("S001/S002: hand-edit the case file, retiring one case with a reason and superseding a second at a live third", async () => {
    await rewriteSpecTestCases(request, {
      projectId: PROJECT_ID,
      benchId,
      testCases: SATCA_TC010_EDITED_PLAN,
    });
  });

  // ── S003: open the spec in a bench and read the panel ────────────────────────
  await test.step("S003: reopen the panel and read it", async () => {
    // Navigate away and back so the plan query refetches against the edited
    // source rather than serving the cached pre-edit plan.
    await page.goto(`/projects/${PROJECT_ID}/benches/${benchId}`);
    await openCasesReview(page);
  });

  const panel = page.getByRole("tabpanel");

  await test.step("S003-O01: the retired case is absent from the live case list", async () => {
    await expect(
      panel.getByTestId("case-row").filter({ hasText: SATCA_TC010_RETIRE_CASE_ID }),
      `${SATCA_TC010_OWNING_SLICES.excluded}: ${SATCA_TC010_RETIRE_CASE_ID} is gone from the live case list`,
    ).toHaveCount(0);
    // The untouched third case is still live, which is both the control for the
    // exclusion above and the precondition the supersession pointer resolves
    // against (a replacement must be present and live to be revealable).
    await expect(
      panel.getByTestId("case-row").filter({ hasText: SATCA_TC010_REPLACEMENT_CASE_ID }),
      `${SATCA_TC010_OWNING_SLICES.live}: the untouched ${SATCA_TC010_REPLACEMENT_CASE_ID} is still live`,
    ).toBeVisible();
  });

  await test.step("S003-O02: both cases appear in the archived section with their state labels", async () => {
    await expect(
      panel.getByTestId("archived-cases"),
      `${SATCA_TC010_OWNING_SLICES.archived}: the archived section is shown once a case is non-live`,
    ).toBeVisible();

    const retired = panel.getByTestId(`archived-case-${SATCA_TC010_RETIRE_CASE_ID}`);
    await expect(
      retired,
      `${SATCA_TC010_OWNING_SLICES.archived}: ${SATCA_TC010_RETIRE_CASE_ID} appears in the archived section`,
    ).toBeVisible();
    // The state is stated in words, not by colour alone (SATCA-FR-003).
    await expect(
      retired,
      `${SATCA_TC010_OWNING_SLICES.contract}: ${SATCA_TC010_RETIRE_CASE_ID} is labelled Retired`,
    ).toContainText("Retired");

    const superseded = panel.getByTestId(`archived-case-${SATCA_TC010_SUPERSEDE_CASE_ID}`);
    await expect(
      superseded,
      `${SATCA_TC010_OWNING_SLICES.archived}: ${SATCA_TC010_SUPERSEDE_CASE_ID} appears in the archived section`,
    ).toBeVisible();
    await expect(
      superseded,
      `${SATCA_TC010_OWNING_SLICES.contract}: ${SATCA_TC010_SUPERSEDE_CASE_ID} is labelled Superseded, distinctly from Retired`,
    ).toContainText("Superseded");
  });

  await test.step("S003-O03: the retired case's reason is shown verbatim", async () => {
    await expect(
      panel.getByTestId(`archived-reason-${SATCA_TC010_RETIRE_CASE_ID}`),
      `${SATCA_TC010_OWNING_SLICES.reason}: the hand-authored reason is rendered verbatim, not summarised`,
    ).toHaveText(SATCA_TC010_RETIRED_REASON);
  });

  await test.step("S003-O04: the superseded case names its replacement", async () => {
    const replacement = panel.getByTestId(`archived-replacement-${SATCA_TC010_SUPERSEDE_CASE_ID}`);
    await expect(
      replacement,
      `${SATCA_TC010_OWNING_SLICES.replacement}: the superseded case names a replacement`,
    ).toBeVisible();
    await expect(
      replacement,
      `${SATCA_TC010_OWNING_SLICES.replacement}: the bare same-spec pointer resolves to ${SATCA_TC010_REPLACEMENT_CASE_ID}`,
    ).toContainText(SATCA_TC010_REPLACEMENT_CASE_ID);
  });
});
