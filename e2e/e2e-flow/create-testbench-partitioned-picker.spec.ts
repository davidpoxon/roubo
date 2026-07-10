import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { loadAppShell, registerFixtureProject, resetWithScenario } from "./_support/scenario.js";
import {
  TSPF_TC_010_ALL_PASSED_CASE_COUNT,
  TSPF_TC_010_ALL_PASSED_PLAN,
  TSPF_TC_010_ALL_PASSED_SLUG,
  TSPF_TC_010_NEEDS_ATTENTION_PLAN,
  TSPF_TC_010_NEEDS_ATTENTION_SLUG,
  TSPF_TC_010_OWNING_SLICES,
} from "./_support/testbench-plan.js";

// E2E (#486): the authoritative `e2e_flow` drift guard for the "create a TestBench
// from the PARTITIONED spec picker, selecting an all-passed spec from the
// disclosure" journey (TSPF-TC-010, TSPF-US-001/US-002,
// TSPF-FR-002/FR-003/FR-004/FR-006). It walks the integrated system end to end
// against the BUILT app: enable the feature, register a fixture project carrying
// BOTH a needs-attention spec (partial results sidecar) and an all-passed spec
// (fully-passed sidecar), drive the empty-slot menu -> spec-picker, observe the
// partition (needs-attention in the main space, all-passed behind a collapsed
// disclosure), expand the disclosure, select the all-passed spec, Create, and
// assert a spec-bound testbench bench is created, matching TSPF-TC-010 step for
// step (S001-S005).
//
// Unlike the per-slice unit tests (#482/#483/#484 own those), this asserts the
// integrated journey, not any single slice's implementation. Each step is wrapped
// in a labelled `test.step` so a failure localises the diverging step, reports the
// expected-vs-actual at that step, and names the owning slice from this unit's
// blocked-by set (the issue's AC7 failure-output contract, mirroring the sibling
// create-testbench-from-empty-slot.spec.ts `OWNING_SLICES` pattern).
//
// The genuinely new fixture mechanism (vs the sibling): the fixture seeds a
// hash-matching `test-results.json` sidecar for each spec, synthesized server-side
// from the seeded plan (scenario.ts `seedResults` -> test.ts), because discovery
// classifies a spec `all-passed` only when a readable, schema-valid, PLAN-HASH-
// MATCHING sidecar records every case passed. Without it every seeded spec would
// be needs-attention and there would be no partition to drive.

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";
const PROJECT_ID = "tspf-tc-010-partitioned";

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), "precondition: read settings").toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(res.status(), "precondition: PUT /api/settings testBench.enabled").toBe(200);
  const body = (await res.json()) as { testBench?: { enabled?: boolean } };
  expect(body.testBench?.enabled, "precondition: TestBench feature enabled").toBe(true);
}

async function gotoBenchList(page: Page, projectId: string): Promise<void> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TSPF-TC-010: create a TestBench from the partitioned picker, selecting an all-passed spec from the disclosure", async ({
  page,
  request,
}) => {
  // ── Preconditions: feature enabled, project with a needs-attention spec AND an
  // all-passed spec, on the bench list view ──────────────────────────────────
  await test.step("Precondition: enable the TestBench feature", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying a needs-attention spec and an all-passed spec", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions on Create; the
      // server pins worktreeSource to local HEAD so no origin remote is needed.
      gitInit: true,
      seedSpecs: [
        {
          slug: TSPF_TC_010_NEEDS_ATTENTION_SLUG,
          testCases: TSPF_TC_010_NEEDS_ATTENTION_PLAN,
          // Partial sidecar: one case passed, one not => needs-attention with a
          // real "1 of 2 passed" per-row summary (S002-O03).
          seedResults: "partial",
        },
        {
          slug: TSPF_TC_010_ALL_PASSED_SLUG,
          testCases: TSPF_TC_010_ALL_PASSED_PLAN,
          // Fully-passed, hash-matching sidecar => the server classifies this spec
          // all-passed, so it is relegated to the collapsed disclosure.
          seedResults: "all-passed",
        },
      ],
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

  // Scope to the spec-picker modal by its accessible name: the empty-slot popover
  // (DialogTrigger) also carries role="dialog", so a bare getByRole("dialog") is
  // ambiguous.
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  const needsAttentionRow = dialog.getByRole("radio", {
    name: new RegExp(`^${TSPF_TC_010_NEEDS_ATTENTION_SLUG}`),
  });
  const disclosure = dialog.getByRole("button", { name: /^All passed/ });
  const allPassedRegion = dialog.locator('[aria-label="All passed specs"]');
  const allPassedRow = allPassedRegion.getByRole("radio", {
    name: new RegExp(`^${TSPF_TC_010_ALL_PASSED_SLUG}`),
  });
  const createButton = dialog.getByRole("button", { name: "Create TestBench" });

  // ── S001: open empty-slot menu -> 'Create a TestBench' -> picker opens ───────
  await test.step("S001: open the empty-slot option menu and click 'Create a TestBench' -> spec-picker modal opens", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await expect(
      page.getByRole("button", { name: "Create a TestBench" }),
      `${TSPF_TC_010_OWNING_SLICES.picker}: 'Create a TestBench' option present`,
    ).toBeVisible();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    // S001-O01: the spec-picker modal opens.
    await expect(
      dialog,
      `${TSPF_TC_010_OWNING_SLICES.picker}: spec-picker modal opens`,
    ).toBeVisible();
    await expect(dialog.getByText("Discovered specs")).toBeVisible();
  });

  // ── S002: main space = only needs-attention specs (with summaries); all-passed
  // spec absent; collapsed 'All passed' disclosure at the list tail ────────────
  await test.step("S002: main space lists only the needs-attention spec with a pass-state summary; the all-passed spec is behind a collapsed disclosure", async () => {
    // S002-O01: the needs-attention spec fills the main space.
    await expect(
      needsAttentionRow,
      `${TSPF_TC_010_OWNING_SLICES.mainSpace}: needs-attention spec listed in the main space`,
    ).toBeVisible();
    // S002-O03: it shows a real pass-state summary (partial sidecar => "1 of 2
    // passed"), derived from the seeded plan + results aggregate.
    await expect(
      needsAttentionRow.getByText("1 of 2 passed"),
      `${TSPF_TC_010_OWNING_SLICES.summary}: needs-attention row shows a per-row pass-state summary`,
    ).toBeVisible();
    // S002-O02: the all-passed spec does NOT appear in the main space (its row is
    // only rendered once the disclosure is expanded).
    await expect(
      dialog.getByRole("radio", { name: new RegExp(`^${TSPF_TC_010_ALL_PASSED_SLUG}`) }),
      `${TSPF_TC_010_OWNING_SLICES.mainSpace}: all-passed spec is absent from the main space`,
    ).toBeHidden();
    // S002-O04: a collapsed 'All passed' disclosure with the spec count sits at
    // the list tail.
    await expect(
      disclosure,
      `${TSPF_TC_010_OWNING_SLICES.disclosure}: an 'All passed' disclosure row is present`,
    ).toBeVisible();
    await expect(
      disclosure,
      `${TSPF_TC_010_OWNING_SLICES.disclosure}: the disclosure is collapsed by default`,
    ).toHaveAttribute("aria-expanded", "false");
    await expect(
      disclosure,
      `${TSPF_TC_010_OWNING_SLICES.disclosure}: the collapsed disclosure shows the all-passed spec count`,
    ).toContainText("1 spec");
    // The expanded region is not present while collapsed.
    await expect(
      allPassedRegion,
      `${TSPF_TC_010_OWNING_SLICES.disclosure}: all-passed rows are hidden while collapsed`,
    ).toBeHidden();
  });

  // ── S003: click the disclosure -> all-passed rows expand (de-emphasized) ─────
  await test.step("S003: click the disclosure -> the all-passed spec expands beneath it, de-emphasized, showing 'All N passed'", async () => {
    await disclosure.click();
    // S003-O01: the disclosure expands and its region of all-passed rows appears.
    await expect(
      disclosure,
      `${TSPF_TC_010_OWNING_SLICES.disclosure}: the disclosure expands on click`,
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      allPassedRegion,
      `${TSPF_TC_010_OWNING_SLICES.expandedRows}: the all-passed rows region is revealed`,
    ).toBeVisible();
    await expect(
      allPassedRow,
      `${TSPF_TC_010_OWNING_SLICES.expandedRows}: the all-passed spec row is de-emphasized in the disclosure region`,
    ).toBeVisible();
    // S003-O02: each expanded row shows an "All N passed" summary.
    await expect(
      allPassedRow.getByText(`All ${TSPF_TC_010_ALL_PASSED_CASE_COUNT} passed`),
      `${TSPF_TC_010_OWNING_SLICES.summary}: the all-passed row shows an "All N passed" summary`,
    ).toBeVisible();
  });

  // ── S004: click an all-passed row -> highlighted, Create enabled ─────────────
  await test.step("S004: click the all-passed spec row -> row highlighted as selected, Create enabled", async () => {
    // Before selection the Create button is disabled.
    await expect(
      createButton,
      `${TSPF_TC_010_OWNING_SLICES.selection}: Create is disabled before a selection`,
    ).toBeDisabled();
    await allPassedRow.click();
    // S004-O01: the row is highlighted as selected (aria-checked), across the
    // group boundary (the selection lives in the shared single-select group).
    await expect(
      allPassedRow,
      `${TSPF_TC_010_OWNING_SLICES.selection}: the selected all-passed row is highlighted (aria-checked)`,
    ).toHaveAttribute("aria-checked", "true");
    // S004-O02: the Create button becomes enabled.
    await expect(
      createButton,
      `${TSPF_TC_010_OWNING_SLICES.selection}: Create becomes enabled after selecting the all-passed spec`,
    ).toBeEnabled();
  });

  // ── S005: click Create -> modal closes, spec-bound testbench bench created ────
  await test.step("S005: click Create -> modal closes and a testbench bench is created bound to the selected all-passed spec", async () => {
    await createButton.click();
    // S005-O01: the modal closes.
    await expect(
      dialog,
      `${TSPF_TC_010_OWNING_SLICES.createBinding}: modal closes on Create`,
    ).toBeHidden();
    // Bench detail view opens at /projects/:id/benches/:benchId.
    await expect(
      page,
      `${TSPF_TC_010_OWNING_SLICES.createBinding}: navigates to the new bench's detail view`,
    ).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/benches/\\d+$`));
    // S005-O02: the created bench is spec-bound, identically to any other spec:
    // its persisted record is a testbench variant bound to the SELECTED all-passed
    // spec's test-cases.json (a genuine worktree binding).
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
      `${TSPF_TC_010_OWNING_SLICES.createBinding}: a testbench-variant bench exists`,
    ).toBeTruthy();
    expect(
      created?.focusedSpecPath,
      `${TSPF_TC_010_OWNING_SLICES.createBinding}: bench is bound to the selected all-passed spec's test-cases.json`,
    ).toMatch(new RegExp(`\\.specifications/${TSPF_TC_010_ALL_PASSED_SLUG}/test-cases\\.json$`));
  });
});
