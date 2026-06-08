import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadAppShell, registerFixtureProject, resetWithScenario } from "./_support/scenario.js";
import { OWNING_SLICES, TC_001_PLAN, TESTBENCH_SPEC_SLUG } from "./_support/testbench-plan.js";

// E2E (#438): the authoritative `e2e_flow` drift guard for the
// "create a TestBench from an empty bench slot using a discovered spec" journey
// (TC-001, US-001/US-002, FR-001/FR-002/FR-004/FR-005). It walks the integrated
// system end to end against the BUILT app: enable the feature, register a fixture
// project carrying a discoverable `.specifications/<slug>/test-cases.json`, drive
// the empty-slot menu -> spec-picker -> select -> Create -> bench detail ->
// TestBench-first tab -> TestBench panel, and assert each leg matches TC-001.
//
// Unlike the per-slice unit tests (#414/#416/#418/#419 own those), this asserts
// the journey, not any single slice's implementation. Each step is wrapped in a
// labelled `test.step` so a failure localises the diverging step, reports the
// expected-vs-actual at that step, and names the owning slice (FR-020 / AC7).
//
// The real create path is used as the genuine drift guard (AC3): the fixture repo
// is `git init`-ed + committed (via `gitInit`) so a real spec-bound worktree is
// provisioned, with worktreeSource pinned to local HEAD so provisioning needs no
// `origin` remote. Spec discovery + the TestBench plan read from the repo root,
// so the focused slug/path + results panel (AC5) render off the seeded spec.

const SCENARIO = "default";
const NOW = "2026-06-08T09:00:00.000Z";
const PROJECT_ID = "tc-001-create-testbench";

// The seeded spec's discovered case count is whatever TC-001's plan carries; the
// picker row renders "<n> case(s)", so the assertion derives the number here
// rather than hard-coding it (keeps the row assertion tied to the seeded plan).
const SEEDED_CASE_COUNT = TC_001_PLAN.cases.length;

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

test("TC-001: create a TestBench from an empty bench slot using a discovered spec", async ({
  page,
  request,
}) => {
  // ── Preconditions: feature enabled, project with a discoverable spec, on the
  // bench list view ──────────────────────────────────────────────────────────
  await test.step("Precondition: enable the TestBench feature (#414)", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying a discoverable spec", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions (AC3); the
      // server pins worktreeSource to local HEAD so no origin remote is needed.
      gitInit: true,
      seedSpecs: [{ slug: TESTBENCH_SPEC_SLUG, testCases: TC_001_PLAN }],
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

  // ── Step 1: open the empty-slot option menu (AC1, #418) ─────────────────────
  await test.step("Step 1: open the option menu on an empty bench slot (#418)", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    // Expected: the menu lists the standard options plus 'Create a TestBench'.
    await expect(
      page.getByRole("button", { name: "Set up blank bench" }),
      OWNING_SLICES.emptySlotMenu,
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Create a TestBench" }),
      `${OWNING_SLICES.emptySlotMenu}: 'Create a TestBench' option present in the menu`,
    ).toBeVisible();
  });

  // ── Step 2: click 'Create a TestBench' -> spec-picker opens (AC1) ───────────
  // Scope to the spec-picker modal by its accessible name: the empty-slot
  // popover (DialogTrigger) also carries role="dialog", so a bare
  // getByRole("dialog") is ambiguous.
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  await test.step("Step 2: click 'Create a TestBench' -> spec-picker modal opens (AC1, #418)", async () => {
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(dialog, `${OWNING_SLICES.specPicker}: spec-picker modal opens`).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Create a TestBench" }),
      OWNING_SLICES.specPicker,
    ).toBeVisible();
    await expect(dialog.getByText("Discovered specs")).toBeVisible();
  });

  // ── Step 3: discovered row shows slug / path / case count (AC2) ─────────────
  // Each discovered spec is a single-select ToggleButton inside a
  // ToggleButtonGroup, so it exposes role="radio"; its accessible name is the
  // concatenation of slug + path + case count, which starts with the slug.
  const specRow = dialog.getByRole("radio", { name: new RegExp(`^${TESTBENCH_SPEC_SLUG}`) });
  await test.step("Step 3: the discovered row shows slug, path, and case count matching the seeded spec (AC2, #418)", async () => {
    await expect(
      specRow,
      `${OWNING_SLICES.discoveredRow}: a discovered row matches the seeded spec slug "${TESTBENCH_SPEC_SLUG}"`,
    ).toBeVisible();
    // Slug.
    await expect(specRow.getByText(TESTBENCH_SPEC_SLUG, { exact: true })).toBeVisible();
    // File path: the discovered path ends at .specifications/<slug>/test-cases.json.
    await expect(
      specRow.getByText(new RegExp(`\\.specifications/${TESTBENCH_SPEC_SLUG}/test-cases\\.json$`)),
      `${OWNING_SLICES.discoveredRow}: row shows the .specifications/<slug>/test-cases.json path`,
    ).toBeVisible();
    // Case count derived from the seeded plan.
    const expectedCount = `${SEEDED_CASE_COUNT} ${SEEDED_CASE_COUNT === 1 ? "case" : "cases"}`;
    await expect(
      specRow.getByText(expectedCount),
      `${OWNING_SLICES.discoveredRow}: row case count == seeded plan (${expectedCount})`,
    ).toBeVisible();
  });

  // ── Step 4: select the row -> highlighted + Create enabled (AC3 precondition) ─
  const createButton = dialog.getByRole("button", { name: "Create TestBench" });
  await test.step("Step 4: select the spec row -> row highlighted, Create enabled (#418)", async () => {
    // Before selection the Create button is disabled.
    await expect(createButton, OWNING_SLICES.specPicker).toBeDisabled();
    await specRow.click();
    await expect(
      specRow,
      `${OWNING_SLICES.specPicker}: selected row is highlighted (aria-checked)`,
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      createButton,
      `${OWNING_SLICES.specPicker}: Create button becomes enabled after selection`,
    ).toBeEnabled();
  });

  // ── Step 5: Create -> modal closes, bench created spec-bound, detail opens (AC3) ─
  await test.step("Step 5: click Create -> modal closes, spec-bound bench created, detail opens (AC3, #416)", async () => {
    await createButton.click();
    await expect(dialog, `${OWNING_SLICES.specPicker}: modal closes on Create`).toBeHidden();
    // Bench detail view opens at /projects/:id/benches/:benchId (first bench => 1).
    await expect(
      page,
      `${OWNING_SLICES.createBinding}: navigates to the new bench's detail view`,
    ).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/benches/\\d+$`));
    // The created bench is spec-bound: its persisted record carries the focused
    // spec path resolved to the seeded test-cases.json (genuine worktree binding).
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
      `${OWNING_SLICES.createBinding}: bench is bound to the selected spec's test-cases.json`,
    ).toMatch(new RegExp(`\\.specifications/${TESTBENCH_SPEC_SLUG}/test-cases\\.json$`));
  });

  // ── Step 6: tabs -> TestBench first (amber), standard tabs retained in order (AC4) ─
  const tablist = page.getByRole("tablist");
  await test.step("Step 6: TestBench is the first tab (amber) with standard tabs retained in order (AC4, #416)", async () => {
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
      `${OWNING_SLICES.variantTabs}: the first tab is the TestBench tab`,
    ).toHaveText(/^TestBench/);
    // It opens selected (the create flow marks the new bench to open on it), and
    // the selected tab carries the amber accent border.
    await expect(
      testBenchTab,
      `${OWNING_SLICES.variantTabs}: TestBench tab is the active (amber-accented) tab`,
    ).toHaveAttribute("aria-selected", "true");
    expect(
      await testBenchTab.evaluate((el) => el.className),
      `${OWNING_SLICES.variantTabs}: active TestBench tab carries the amber accent`,
    ).toContain("border-amber-500");
  });

  // ── Step 7: TestBench tab content -> focused slug/path + results panel (AC5) ─
  await test.step("Step 7: TestBench tab content loads focused slug/path + results panel (AC5, #419)", async () => {
    // The create flow opens the bench on the TestBench tab already; click it
    // explicitly to mirror TC-001's "Click the TestBench tab" step.
    await tablist.getByRole("tab", { name: /^TestBench/ }).click();
    const testBenchPanel = page.getByRole("tabpanel");
    await expect(testBenchPanel).toBeVisible();
    // Focused spec identity: slug + the full path to its test-cases.json.
    await expect(
      testBenchPanel.getByText(TESTBENCH_SPEC_SLUG, { exact: true }),
      `${OWNING_SLICES.reviewPanel}: focused spec slug is displayed`,
    ).toBeVisible();
    await expect(
      testBenchPanel.getByText(
        new RegExp(`\\.specifications/${TESTBENCH_SPEC_SLUG}/test-cases\\.json$`),
      ),
      `${OWNING_SLICES.reviewPanel}: focused spec path is displayed`,
    ).toBeVisible();
    // Results panel: the overall progress rollup is the head of the results
    // surface and is labelled "Overall".
    await expect(
      testBenchPanel.getByText("Overall"),
      `${OWNING_SLICES.reviewPanel}: the results panel (overall progress) is visible`,
    ).toBeVisible();
    // The seeded plan's single case surfaces in the case list, proving the panel
    // loaded the focused spec's plan rather than an empty/error state.
    await expect(
      testBenchPanel.getByText("TC-001"),
      `${OWNING_SLICES.reviewPanel}: the focused spec's cases are listed`,
    ).toBeVisible();
  });
});
