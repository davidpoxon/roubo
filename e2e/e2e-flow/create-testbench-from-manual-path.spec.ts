import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadAppShell, registerFixtureProject, resetWithScenario } from "./_support/scenario.js";
import { OWNING_SLICES, TC_006_PLAN, TESTBENCH_SPEC_SLUG } from "./_support/testbench-plan.js";

// E2E (#443): the authoritative `e2e_flow` drift guard for the
// "create a TestBench from a valid manual file path" journey (TC-006, US-012,
// FR-003/FR-004). It walks the integrated system end to end against the BUILT
// app: enable the feature, register a fixture project carrying a real
// `.specifications/<slug>/test-cases.json`, open the empty-slot menu ->
// spec-picker, then drive the manual-path escape hatch (type the path -> live
// validation -> valid state -> Create) and assert the spec-bound bench, detail
// view, TestBench-first tab, and review panel match TC-006.
//
// The only divergence from TC-001 (#438, create-from-empty-slot) is the
// selection mechanism: instead of clicking a discovered spec row, this types a
// repo-relative path into the manual-path TextField ("Or enter a path") and
// asserts the aria-live status region transitions "Validating..." ->
// "Valid: <slug> (n cases)". The create/detail/tab/panel legs are identical.
//
// Unlike the per-slice unit tests (#414/#416/#418/#419 own those), this asserts
// the journey, not any single slice's implementation. Each step is wrapped in a
// labelled `test.step` so a failure localises the diverging step, reports the
// expected-vs-actual at that step, and names the owning slice (FR-020 / AC5).
//
// The real validate + create path is used as the genuine drift guard (AC3/AC4):
// the fixture repo is `git init`-ed + committed (via `gitInit`) so a real
// spec-bound worktree is provisioned, with worktreeSource pinned to local HEAD
// so provisioning needs no `origin` remote. The typed path is the repo-relative
// `.specifications/<slug>/test-cases.json` the placeholder advertises, which the
// real validate endpoint (POST /:projectId/testbench/specs/validate, debounced
// 300ms in useManualPathValidation) resolves against the repo root.

const SCENARIO = "default";
const NOW = "2026-06-08T09:00:00.000Z";
const PROJECT_ID = "tc-006-create-testbench-manual";

// The seeded spec's case count is whatever TC-006's plan carries; the valid
// status line renders "Valid: <slug> (<n> case(s))", so the assertion derives
// the number here rather than hard-coding it (keeps it tied to the seeded plan).
const SEEDED_CASE_COUNT = TC_006_PLAN.cases.length;

// The repo-relative path the user types into the manual-path escape hatch. This
// is exactly the form the input placeholder advertises and the form
// `validateManualPath` resolves against the repo root, so it points at the
// seeded `.specifications/<slug>/test-cases.json` from the project root.
const MANUAL_PATH = `.specifications/${TESTBENCH_SPEC_SLUG}/test-cases.json`;

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body. This makes the precondition
  // explicit and deterministic regardless of the persisted default.
  const current = await request.get("/api/settings");
  expect(current.status(), OWNING_SLICES.enable).toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(res.status(), `${OWNING_SLICES.enable}: PUT /api/settings testBench.enabled`).toBe(200);
  const body = (await res.json()) as { testBench?: { enabled?: boolean } };
  expect(body.testBench?.enabled, OWNING_SLICES.enable).toBe(true);
}

async function gotoBenchList(page: Page, projectId: string): Promise<void> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TC-006: create a TestBench with a valid manual file path", async ({ page, request }) => {
  // ── Preconditions: feature enabled, project with a real spec on disk, on the
  // bench list view ──────────────────────────────────────────────────────────
  await test.step("Precondition: enable the TestBench feature (#414)", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying a spec on disk", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions (AC3); the
      // server pins worktreeSource to local HEAD so no origin remote is needed.
      gitInit: true,
      // Seed the spec the manual path points at, under the same slug, so the
      // typed `.specifications/<slug>/test-cases.json` resolves to a real file.
      seedSpecs: [{ slug: TESTBENCH_SPEC_SLUG, testCases: TC_006_PLAN }],
    });
    expect(projectId).toBe(PROJECT_ID);
  });

  await loadAppShell(page);
  await test.step("Precondition: on the bench list view for the project", async () => {
    await gotoBenchList(page, PROJECT_ID);
    // The fixture roubo.yaml caps benches at 5, so slot 1 renders as an empty,
    // available bench card.
    await expect(page.getByText("Bench 1")).toBeVisible();
    await expect(page.getByText("Available").first()).toBeVisible();
  });

  // ── Precondition: open the empty-slot menu -> spec-picker modal (#418) ───────
  // Shared with TC-001: the manual-path journey starts from the same modal.
  await test.step("Precondition: open the option menu on an empty bench slot (#418)", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await expect(
      page.getByRole("button", { name: "Create a TestBench" }),
      `${OWNING_SLICES.emptySlotMenu}: 'Create a TestBench' option present in the menu`,
    ).toBeVisible();
  });

  // Scope to the spec-picker modal by its accessible name: the empty-slot
  // popover (DialogTrigger) also carries role="dialog", so a bare
  // getByRole("dialog") is ambiguous.
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  await test.step("Precondition: spec-picker modal opens (#418)", async () => {
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(dialog, `${OWNING_SLICES.specPicker}: spec-picker modal opens`).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Create a TestBench" }),
      OWNING_SLICES.specPicker,
    ).toBeVisible();
  });

  // ── TC-006-S1: locate the manual-path input (AC1 precondition, #418) ─────────
  // The escape hatch is a RAC TextField labelled "Or enter a path"; it has no
  // data-testid, so it is located by its accessible label.
  const manualInput = dialog.getByLabel("Or enter a path");
  const createButton = dialog.getByRole("button", { name: "Create TestBench" });
  await test.step("TC-006-S1: locate the manual-path input field in the modal (#418)", async () => {
    await expect(
      manualInput,
      `${OWNING_SLICES.manualPathInput}: the 'Or enter a path' input is present`,
    ).toBeVisible();
    // Before any input the Create button is disabled (no valid selection yet).
    await expect(createButton, OWNING_SLICES.specPicker).toBeDisabled();
  });

  // The aria-live status region beneath the input is the testable surface for
  // the validating / valid / invalid states (FR-003).
  const status = dialog.locator("#manual-path-status");

  // ── TC-006-S2: type the path -> validating indicator (AC1, #418) ────────────
  await test.step("TC-006-S2: type a valid path -> input shows a validating indicator (AC1, #418)", async () => {
    await manualInput.fill(MANUAL_PATH);
    // Validation is debounced 300ms then hits the real endpoint; auto-waiting
    // expects (no fixed sleeps) catch the transient "Validating..." state. The
    // status region either shows "Validating..." in flight or settles on
    // "Valid:" once the (local) request resolves, so assert it reaches one of
    // the in-progress/settled states rather than racing the debounce window.
    await expect(
      status,
      `${OWNING_SLICES.manualPathValidation}: status shows a validating indicator while validating`,
    ).toHaveText(/Validating\.\.\.|Valid:/);
  });

  // ── TC-006-S3: validation completes -> valid state, Create enabled, no error (AC2) ─
  await test.step("TC-006-S3: validation completes -> valid state, Create enabled, no error (AC2, #418)", async () => {
    // Valid: "<slug> (<n> case(s))". The count is derived from the seeded plan.
    // toHaveText normalises and matches the whole status region's text, so a
    // match proves the green-check valid line is the ONLY content there: any
    // "Validating..." spinner text or an error string (the invalid branch
    // renders `errors.join("; ")`) would make the full-text match fail. That is
    // the "valid state + no error message" assertion in one (AC2).
    const caseWord = SEEDED_CASE_COUNT === 1 ? "case" : "cases";
    await expect(
      status,
      `${OWNING_SLICES.manualPathValidation}: status reaches "Valid: ${TESTBENCH_SPEC_SLUG} (${SEEDED_CASE_COUNT} ${caseWord})" with no error or spinner text`,
    ).toHaveText(
      new RegExp(`^Valid:\\s*${TESTBENCH_SPEC_SLUG}\\s*\\(${SEEDED_CASE_COUNT} ${caseWord}\\)$`),
    );
    // The valid manual path is a complete selection, so Create enables.
    await expect(
      createButton,
      `${OWNING_SLICES.specPicker}: Create button becomes enabled after a valid manual path`,
    ).toBeEnabled();
  });

  // ── TC-006-S4: Create -> modal closes, bench created spec-bound, detail opens (AC3) ─
  await test.step("TC-006-S4: click Create -> modal closes, spec-bound bench created, detail opens (AC3, #416)", async () => {
    await createButton.click();
    await expect(dialog, `${OWNING_SLICES.specPicker}: modal closes on Create`).toBeHidden();
    // Bench detail view opens at /projects/:id/benches/:benchId (first bench => 1).
    await expect(
      page,
      `${OWNING_SLICES.createBinding}: navigates to the new bench's detail view`,
    ).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/benches/\\d+$`));
    // The created bench is spec-bound: its persisted record carries the focused
    // spec path resolved to the manually specified test-cases.json (genuine
    // worktree binding off the typed path).
    const benches = await request.get(`/api/projects/${PROJECT_ID}/benches`);
    expect(benches.status()).toBe(200);
    const list = (await benches.json()) as Array<{
      id: number;
      variant?: string;
      focusedSpecPath?: string;
    }>;
    const created = list.find((b) => b.variant === "testbench");
    expect(
      created,
      `${OWNING_SLICES.createBinding}: a testbench-variant bench exists`,
    ).toBeTruthy();
    expect(
      created?.focusedSpecPath,
      `${OWNING_SLICES.createBinding}: bench is bound to the manually specified test-cases.json`,
    ).toMatch(new RegExp(`\\.specifications/${TESTBENCH_SPEC_SLUG}/test-cases\\.json$`));
  });

  // ── TC-006-S4 (cont.): TestBench first tab + correct spec path in the panel (AC3) ─
  const tablist = page.getByRole("tablist");
  await test.step("TC-006-S4: TestBench is the first (amber) tab and the panel shows the correct spec path (AC3, #416/#419)", async () => {
    await expect(tablist).toBeVisible();
    const tabs = tablist.getByRole("tab");
    // Inspection is only present when configured; the fixture has no inspection
    // component, so the expected order is TestBench, Components, Terminal, Info.
    await expect(
      tabs,
      `${OWNING_SLICES.variantTabs}: tab order is TestBench, Components, Terminal, Info`,
    ).toHaveText([/^TestBench/, /^Components/, /^Terminal/, /^Info/]);
    const testBenchTab = tabs.first();
    await expect(
      testBenchTab,
      `${OWNING_SLICES.variantTabs}: TestBench tab is the active (amber-accented) tab`,
    ).toHaveAttribute("aria-selected", "true");
    expect(
      await testBenchTab.evaluate((el) => el.className),
      `${OWNING_SLICES.variantTabs}: active TestBench tab carries the amber accent`,
    ).toContain("border-amber-500");

    // The create flow opens the bench on the TestBench tab already; click it
    // explicitly to mirror TC-006's "Bench detail opens with the TestBench tab".
    await tablist.getByRole("tab", { name: /^TestBench/ }).click();
    const testBenchPanel = page.getByRole("tabpanel");
    await expect(testBenchPanel).toBeVisible();
    // Focused spec identity: slug + the full path to the manually specified
    // test-cases.json (the "correct spec path" of AC3).
    await expect(
      testBenchPanel.getByText(TESTBENCH_SPEC_SLUG, { exact: true }),
      `${OWNING_SLICES.reviewPanel}: focused spec slug is displayed`,
    ).toBeVisible();
    await expect(
      testBenchPanel.getByText(
        new RegExp(`\\.specifications/${TESTBENCH_SPEC_SLUG}/test-cases\\.json$`),
      ),
      `${OWNING_SLICES.reviewPanel}: the correct (manually specified) spec path is displayed`,
    ).toBeVisible();
    // The seeded plan's case surfaces in the case list, proving the panel loaded
    // the manually specified spec's plan rather than an empty/error state.
    await expect(
      testBenchPanel.getByText("TC-006"),
      `${OWNING_SLICES.reviewPanel}: the focused spec's cases are listed`,
    ).toBeVisible();
  });
});
