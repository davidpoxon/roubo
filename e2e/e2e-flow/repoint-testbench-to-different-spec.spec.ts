import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  OWNING_SLICES_TC007,
  TC_007_PLAN_A,
  TC_007_PLAN_B,
  TC_007_SPEC_A_SLUG,
  TC_007_SPEC_B_SLUG,
} from "./_support/testbench-plan.js";

// E2E (#444): the authoritative `e2e_flow` drift guard for the
// "re-point a TestBench to a different spec, preserve results per spec" journey
// (TC-007, US-013, FR-024/FR-004). It is the TC-007 sibling of #438's TC-001
// create-flow guard and mirrors that file's structure: labelled `test.step`s, an
// owning-slice map for failure localization, two drift-guard plan projections
// seeded into a fixture repo, and assertions against the BUILT app.
//
// The journey: create a TestBench bound to spec-A through the real create flow,
// record a result against spec-A, re-point to spec-B via the header
// "Change focused spec" action, then re-point back to spec-A and prove spec-A's
// result survived intact with none of spec-B's case ids mixed in.
//
// Per-spec result isolation is enforced server-side (results are keyed by the
// focused spec's slug in testbench-store; re-point only swaps
// `bench.focusedSpecPath`), so this spec proves that contract rather than
// implementing it. Unlike the per-slice unit tests (#414/#416/#423 own those),
// this asserts the integrated journey; each step is wrapped in a labelled
// `test.step` so a failure localises the diverging step, reports the
// expected-vs-actual at that step, and names the owning slice (FR-020 / AC5).
//
// The real create + re-point paths are used as the genuine drift guard: the
// fixture repo is `git init`-ed + committed (via `gitInit`) so a real spec-bound
// worktree is provisioned, with worktreeSource pinned to local HEAD so
// provisioning needs no `origin` remote.

const SCENARIO = "default";
const NOW = "2026-06-08T09:00:00.000Z";
const PROJECT_ID = "tc-007-repoint-testbench";

// The single spec-A case the test records a result against, and the single
// spec-B case that must never leak into spec-A's result set.
const SPEC_A_CASE_ID = TC_007_PLAN_A.cases[0].id;
const SPEC_A_OBSERVATION_ID = TC_007_PLAN_A.cases[0].steps[0].observations[0].id;
const SPEC_B_CASE_ID = TC_007_PLAN_B.cases[0].id;

const SPEC_A_PATH_RE = new RegExp(`\\.specifications/${TC_007_SPEC_A_SLUG}/test-cases\\.json$`);
const SPEC_B_PATH_RE = new RegExp(`\\.specifications/${TC_007_SPEC_B_SLUG}/test-cases\\.json$`);

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), OWNING_SLICES_TC007.enable).toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(res.status(), `${OWNING_SLICES_TC007.enable}: PUT /api/settings testBench.enabled`).toBe(
    200,
  );
  const body = (await res.json()) as { testBench?: { enabled?: boolean } };
  expect(body.testBench?.enabled, OWNING_SLICES_TC007.enable).toBe(true);
}

async function gotoBenchList(page: Page, projectId: string): Promise<void> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
}

// Read the testbench plan + results for a bench. The panel renders off this same
// payload, so it is the canonical evidence for the per-spec result isolation
// assertions (AC3): results are keyed by case id under the currently focused
// spec, so switching focus swaps the entire result set.
async function fetchPlanAndResults(
  request: APIRequestContext,
  projectId: string,
  benchId: number,
): Promise<{
  plan: { specSlug: string; cases: Array<{ id: string }> };
  results: { caseResults: Record<string, unknown> } | null;
}> {
  const res = await request.get(`/api/projects/${projectId}/benches/${benchId}/testbench/plan`);
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    plan: { specSlug: string; cases: Array<{ id: string }> };
    results: { caseResults: Record<string, unknown> } | null;
  };
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TC-007: re-point a TestBench to a different spec, preserving each spec's results independently", async ({
  page,
  request,
}) => {
  // ── Preconditions: feature enabled, project with two discoverable specs ──────
  await test.step("Precondition: enable the TestBench feature (#414)", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying two discoverable specs (spec-A, spec-B)", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions; the server
      // pins worktreeSource to local HEAD so no origin remote is needed.
      gitInit: true,
      seedSpecs: [
        { slug: TC_007_SPEC_A_SLUG, testCases: TC_007_PLAN_A },
        { slug: TC_007_SPEC_B_SLUG, testCases: TC_007_PLAN_B },
      ],
    });
    expect(projectId).toBe(PROJECT_ID);
  });

  await loadAppShell(page);
  await test.step("Precondition: on the bench list view for the project", async () => {
    await gotoBenchList(page, PROJECT_ID);
    await expect(page.getByText("Bench 1")).toBeVisible();
    await expect(page.getByText("Available").first()).toBeVisible();
  });

  // ── Precondition: create the TestBench bound to spec-A via the real create flow ─
  const createDialog = page.getByRole("dialog", { name: "Create a TestBench" });
  await test.step("Precondition: create a TestBench bound to spec-A through the create flow (#418/#416)", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(
      createDialog,
      `${OWNING_SLICES_TC007.createBinding}: spec-picker modal opens`,
    ).toBeVisible();
    const specARow = createDialog.getByRole("radio", {
      name: new RegExp(`^${TC_007_SPEC_A_SLUG}`),
    });
    await expect(
      specARow,
      `${OWNING_SLICES_TC007.createBinding}: spec-A discovered in the create picker`,
    ).toBeVisible();
    await specARow.click();
    const createButton = createDialog.getByRole("button", { name: "Create TestBench" });
    await expect(createButton).toBeEnabled();
    await createButton.click();
    await expect(createDialog, `${OWNING_SLICES_TC007.createBinding}: modal closes`).toBeHidden();
    await expect(
      page,
      `${OWNING_SLICES_TC007.createBinding}: navigates to the new bench's detail view`,
    ).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/benches/\\d+$`));
    // The created bench is spec-bound to spec-A's test-cases.json.
    const benches = await request.get(`/api/projects/${PROJECT_ID}/benches`);
    expect(benches.status()).toBe(200);
    const list = (await benches.json()) as Array<{
      id: number;
      variant?: string;
      focusedSpecPath?: string;
    }>;
    const created = list.find((b) => b.variant === "testbench");
    expect(
      created?.focusedSpecPath,
      `${OWNING_SLICES_TC007.createBinding}: bench bound to spec-A's test-cases.json`,
    ).toMatch(SPEC_A_PATH_RE);
  });

  // Resolve the created bench id from the URL for the API result calls below.
  const benchId = Number(new URL(page.url()).pathname.split("/").pop());
  expect(Number.isInteger(benchId), "resolved a numeric bench id from the detail URL").toBe(true);

  // ── Precondition: record at least one result against spec-A ──────────────────
  await test.step("Precondition: record a result against spec-A (mark an observation pass)", async () => {
    const res = await request.put(
      `/api/projects/${PROJECT_ID}/benches/${benchId}/testbench/cases/${SPEC_A_CASE_ID}/observations/${SPEC_A_OBSERVATION_ID}`,
      { data: { result: "pass" } },
    );
    expect(
      res.status(),
      `${OWNING_SLICES_TC007.reviewPanel}: marking spec-A observation pass returns 200`,
    ).toBe(200);
    // The recorded result is stored under spec-A's slug, keyed by the case id.
    const planAndResults = await fetchPlanAndResults(request, PROJECT_ID, benchId);
    expect(planAndResults.plan.specSlug).toBe(TC_007_SPEC_A_SLUG);
    expect(
      planAndResults.results?.caseResults[SPEC_A_CASE_ID],
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-A's case carries a recorded result`,
    ).toBeTruthy();
  });

  // ── Open the TestBench tab and confirm the recorded result is reflected ──────
  const tablist = page.getByRole("tablist");
  await test.step("Open the TestBench tab; the recorded spec-A result is reflected (#416)", async () => {
    // The result was recorded out-of-band via the API after the create flow
    // already opened the panel, so reload to fetch the panel's plan + results
    // fresh (mirrors a "reload the panel" step) rather than serving a cached
    // pre-mark snapshot.
    await page.reload();
    await tablist.getByRole("tab", { name: /^TestBench/ }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel).toBeVisible();
    // The view toggle now opens on the "Batches" surface by default (#359);
    // switch to the Cases review this step asserts on (overall rollup + result).
    // The choice is remembered per bench, so later panel reads stay on Cases.
    await showTestBenchCasesView(page);
    await expect(
      panel.getByText(TC_007_SPEC_A_SLUG, { exact: true }),
      `${OWNING_SLICES_TC007.reviewPanel}: spec-A is the focused spec in the header`,
    ).toBeVisible();
    // The Overall rollup reports one passed of one, proving the result loaded.
    await expect(
      panel.getByRole("img", { name: /Overall: 1 passed.*of 1/ }),
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-A's overall rollup shows 1 passed of 1`,
    ).toBeVisible();
    // The spec-A case is listed with a Passed status.
    await expect(
      panel.getByText(SPEC_A_CASE_ID),
      `${OWNING_SLICES_TC007.reviewPanel}: spec-A's case is listed`,
    ).toBeVisible();
    await expect(
      panel.getByText("Passed").first(),
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-A's case shows the recorded Passed status`,
    ).toBeVisible();
  });

  // ── Step 1+2 (AC1): open the picker -> spec-A shown active, spec-B listed ─────
  const repointDialog = page.getByRole("dialog", { name: "Change focused spec" });
  await test.step("Step 1+2 (AC1): 'Change focused spec' opens the picker with spec-A active and spec-B listed (#423)", async () => {
    await page.getByRole("button", { name: "Change focused spec" }).click();
    await expect(
      repointDialog,
      `${OWNING_SLICES_TC007.repointAction}: re-point picker opens`,
    ).toBeVisible();
    await expect(
      repointDialog.getByRole("heading", { name: "Change focused spec" }),
      OWNING_SLICES_TC007.specPicker,
    ).toBeVisible();
    await expect(
      repointDialog.getByRole("button", { name: /Re-point TestBench/ }),
      `${OWNING_SLICES_TC007.specPicker}: picker is in re-point mode`,
    ).toBeVisible();
    // spec-A row carries the Active marker (the currently focused spec).
    const specARow = repointDialog.getByRole("radio", {
      name: new RegExp(`^${TC_007_SPEC_A_SLUG}`),
    });
    await expect(
      specARow.getByText("Active"),
      `${OWNING_SLICES_TC007.specPicker}: spec-A is shown as the active (current) spec`,
    ).toBeVisible();
    // spec-B is listed as a discovered option.
    await expect(
      repointDialog.getByRole("radio", { name: new RegExp(`^${TC_007_SPEC_B_SLUG}`) }),
      `${OWNING_SLICES_TC007.specPicker}: spec-B is listed among the discovered specs`,
    ).toBeVisible();
  });

  // ── Step 3+4 (AC2): select spec-B, confirm -> header shows spec-B focused ─────
  await test.step("Step 3+4 (AC2): select spec-B, confirm re-point -> header shows spec-B and its plan loads (#423)", async () => {
    const specBRow = repointDialog.getByRole("radio", {
      name: new RegExp(`^${TC_007_SPEC_B_SLUG}`),
    });
    await specBRow.click();
    await expect(
      specBRow,
      `${OWNING_SLICES_TC007.specPicker}: spec-B row highlighted on selection`,
    ).toHaveAttribute("aria-checked", "true");
    const confirm = repointDialog.getByRole("button", { name: /Re-point TestBench/ });
    await expect(
      confirm,
      `${OWNING_SLICES_TC007.specPicker}: confirm enabled after selecting spec-B`,
    ).toBeEnabled();
    await confirm.click();
    await expect(
      repointDialog,
      `${OWNING_SLICES_TC007.repointAction}: modal closes on confirm`,
    ).toBeHidden();
    const panel = page.getByRole("tabpanel");
    // The header now shows spec-B as the focused spec.
    await expect(
      panel.getByText(SPEC_B_PATH_RE),
      `${OWNING_SLICES_TC007.repointAction}: header shows spec-B as the focused spec`,
    ).toBeVisible();
    // Staleness is re-evaluated against the newly focused plan: the panel reloads
    // spec-B's plan, so spec-B's case is listed and spec-A's case is gone.
    await expect(
      panel.getByText(SPEC_B_CASE_ID),
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-B's plan loaded (its case is listed)`,
    ).toBeVisible();
    await expect(
      panel.getByText(SPEC_A_CASE_ID),
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-A's case no longer listed under spec-B`,
    ).toBeHidden();
    // spec-B is freshly focused with no recorded results: Overall shows 0 of 1.
    await expect(
      panel.getByRole("img", { name: /Overall: 0 passed.*of 1/ }),
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-B starts with no recorded results`,
    ).toBeVisible();
  });

  // ── Step 5 (AC3): re-point back to spec-A -> spec-A's result preserved intact ─
  await test.step("Step 5 (AC3): re-point back to spec-A -> spec-A's prior result preserved, no spec-B results mixed in (#423)", async () => {
    await page.getByRole("button", { name: "Change focused spec" }).click();
    await expect(repointDialog).toBeVisible();
    // In this re-point, spec-B is now the active spec.
    await expect(
      repointDialog
        .getByRole("radio", { name: new RegExp(`^${TC_007_SPEC_B_SLUG}`) })
        .getByText("Active"),
      `${OWNING_SLICES_TC007.specPicker}: spec-B shown active after the first re-point`,
    ).toBeVisible();
    const specARow = repointDialog.getByRole("radio", {
      name: new RegExp(`^${TC_007_SPEC_A_SLUG}`),
    });
    await specARow.click();
    await repointDialog.getByRole("button", { name: /Re-point TestBench/ }).click();
    await expect(repointDialog).toBeHidden();

    const panel = page.getByRole("tabpanel");
    await expect(
      panel.getByText(SPEC_A_PATH_RE),
      `${OWNING_SLICES_TC007.repointAction}: header shows spec-A again after switching back`,
    ).toBeVisible();
    // spec-A's previously recorded result is fully preserved and displayed.
    await expect(
      panel.getByRole("img", { name: /Overall: 1 passed.*of 1/ }),
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-A's recorded result preserved (1 passed of 1)`,
    ).toBeVisible();
    await expect(
      panel.getByText("Passed").first(),
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-A's case still shows Passed after the round-trip`,
    ).toBeVisible();
    await expect(
      panel.getByText(SPEC_A_CASE_ID),
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-A's case is listed again`,
    ).toBeVisible();
    // No results from spec-B are mixed into spec-A's result set: the server-side
    // result store is keyed by spec slug, so spec-A's caseResults never carry
    // spec-B's case id.
    const planAndResults = await fetchPlanAndResults(request, PROJECT_ID, benchId);
    expect(planAndResults.plan.specSlug).toBe(TC_007_SPEC_A_SLUG);
    expect(
      planAndResults.results?.caseResults[SPEC_A_CASE_ID],
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-A's result still present after the round-trip`,
    ).toBeTruthy();
    expect(
      Object.keys(planAndResults.results?.caseResults ?? {}),
      `${OWNING_SLICES_TC007.resultsIsolation}: spec-A's result set contains none of spec-B's case ids`,
    ).not.toContain(SPEC_B_CASE_ID);
  });
});
