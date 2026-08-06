import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  SATCA_ARCHIVED_PLAN,
  SATCA_ARCHIVED_REASON,
  SATCA_ARCHIVED_SPEC_SLUG,
  SATCA_LIVE_PLAN,
  SATCA_LIVE_SPEC_SLUG,
  SATCA_PICKER_OWNING_SLICES,
  SATCA_SUPERSEDED_PLAN,
  SATCA_SUPERSEDED_SPEC_SLUG,
} from "./_support/testbench-plan.js";

// E2E (#770): the integrated drift guard for the "spec picker hides archived
// specs by default and reveals them on demand" journey
// (SATCA-TC-035/036/037/038, SATCA-FR-015/FR-016/FR-018, SATCA-US-004/US-005/
// US-011). It runs against the BUILT app with a fixture repo carrying three real
// specs: one live (no manifest), one archived with a reason, and one recorded as
// superseded by another slug. The lifecycle records are written into each spec's
// `.specifications/<slug>/manifest.json` by the fixture route before git init, so
// discovery reads them from disk exactly as it would in a real project, and the
// provisioned bench worktree carries them too.
//
// Steps mirror the test cases: open the picker (archived specs absent), press the
// reveal control (they appear, labelled in words), inspect the superseded one (it
// names its replacement), then select an archived spec and create the bench (it
// loads, and the panel says the spec is archived).

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";
const PROJECT_ID = "satca-tc-035-archived-picker";

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
}

async function gotoBenchList(page: Page, projectId: string): Promise<void> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("SATCA-TC-035/036/037/038: archived specs are hidden by default, revealed labelled, and still loadable", async ({
  page,
  request,
}) => {
  await test.step("Precondition: enable the TestBench feature", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying a live, an archived, and a superseded spec", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions on Create,
      // carrying the seeded manifests into the bench's own workspace.
      gitInit: true,
      seedSpecs: [
        { slug: SATCA_LIVE_SPEC_SLUG, testCases: SATCA_LIVE_PLAN },
        {
          slug: SATCA_ARCHIVED_SPEC_SLUG,
          testCases: SATCA_ARCHIVED_PLAN,
          lifecycle: { archived: true, reason: SATCA_ARCHIVED_REASON },
        },
        {
          slug: SATCA_SUPERSEDED_SPEC_SLUG,
          testCases: SATCA_SUPERSEDED_PLAN,
          lifecycle: { archived: true, supersededBy: SATCA_LIVE_SPEC_SLUG },
        },
      ],
    });
    expect(projectId).toBe(PROJECT_ID);
  });

  await loadAppShell(page);
  await test.step("Precondition: on the bench list view for the project", async () => {
    await gotoBenchList(page, PROJECT_ID);
    await expect(page.getByText("Bench 1")).toBeVisible();
  });

  // Scope to the spec-picker modal by its accessible name: the empty-slot popover
  // (DialogTrigger) also carries role="dialog".
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  const liveRow = dialog.getByRole("radio", { name: new RegExp(`^${SATCA_LIVE_SPEC_SLUG}`) });
  const revealControl = dialog.getByRole("button", { name: /^Show archived/ });
  const archivedRegion = dialog.locator('[aria-label="Archived specs"]');
  const archivedRow = archivedRegion.getByRole("radio", {
    name: new RegExp(`^${SATCA_ARCHIVED_SPEC_SLUG}`),
  });
  const supersededRow = archivedRegion.getByRole("radio", {
    name: new RegExp(`^${SATCA_SUPERSEDED_SPEC_SLUG}`),
  });
  const createButton = dialog.getByRole("button", { name: "Create TestBench" });

  // ── SATCA-TC-035: the archived specs are absent from the default list ────────
  await test.step("TC-035: open the spec picker -> only the live spec is listed", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(dialog, `${SATCA_PICKER_OWNING_SLICES.hidden}: picker opens`).toBeVisible();
    // S001-O01: the live spec is listed.
    await expect(
      liveRow,
      `${SATCA_PICKER_OWNING_SLICES.discovery}: the live spec is listed by default`,
    ).toBeVisible();
    // S001-O02: neither archived spec is among them, in either live group.
    await expect(
      dialog.getByRole("radio", { name: new RegExp(`^${SATCA_ARCHIVED_SPEC_SLUG}`) }),
      `${SATCA_PICKER_OWNING_SLICES.hidden}: the archived spec is absent from the default list`,
    ).toBeHidden();
    await expect(
      dialog.getByRole("radio", { name: new RegExp(`^${SATCA_SUPERSEDED_SPEC_SLUG}`) }),
      `${SATCA_PICKER_OWNING_SLICES.hidden}: the superseded spec is absent from the default list`,
    ).toBeHidden();
    // The reveal control is present and off.
    await expect(
      revealControl,
      `${SATCA_PICKER_OWNING_SLICES.reveal}: a show-archived control is present`,
    ).toBeVisible();
    await expect(
      revealControl,
      `${SATCA_PICKER_OWNING_SLICES.reveal}: the control is off by default`,
    ).toHaveAttribute("aria-pressed", "false");
  });

  // ── SATCA-TC-036: the control reveals them, labelled, beside the live ones ───
  await test.step("TC-036: activate the show-archived control -> archived specs appear, labelled in text, live specs still listed", async () => {
    await revealControl.click();
    await expect(
      revealControl,
      `${SATCA_PICKER_OWNING_SLICES.reveal}: the control reads as pressed once activated`,
    ).toHaveAttribute("aria-pressed", "true");
    // S001-O01: the archived spec appears.
    await expect(
      archivedRow,
      `${SATCA_PICKER_OWNING_SLICES.reveal}: the archived spec is revealed`,
    ).toBeVisible();
    // S001-O02: it carries a visible archived label in text (plus its reason).
    await expect(
      archivedRow,
      `${SATCA_PICKER_OWNING_SLICES.labels}: the revealed row is labelled Archived in text`,
    ).toContainText("Archived");
    await expect(
      archivedRow,
      `${SATCA_PICKER_OWNING_SLICES.labels}: the recorded reason is shown`,
    ).toContainText(SATCA_ARCHIVED_REASON);
    // S001-O03: the live specs remain listed.
    await expect(
      liveRow,
      `${SATCA_PICKER_OWNING_SLICES.reveal}: the live spec remains listed alongside`,
    ).toBeVisible();
  });

  // ── SATCA-TC-037: a superseded spec is labelled distinctly and names its
  // replacement ───────────────────────────────────────────────────────────────
  await test.step("TC-037: the superseded spec is labelled superseded and names the spec that replaced it", async () => {
    // S001-O01: labelled superseded rather than merely archived.
    await expect(
      supersededRow,
      `${SATCA_PICKER_OWNING_SLICES.labels}: the superseded row is labelled Superseded`,
    ).toContainText("Superseded");
    // S001-O02: the superseding spec's slug is displayed.
    await expect(
      supersededRow,
      `${SATCA_PICKER_OWNING_SLICES.labels}: the superseding spec's slug is displayed`,
    ).toContainText(SATCA_LIVE_SPEC_SLUG);
  });

  // ── SATCA-TC-038: an archived spec can still be loaded, and the panel says so ─
  await test.step("TC-038: select the archived spec and create -> it loads and the panel indicates it is archived", async () => {
    await archivedRow.click();
    await expect(
      archivedRow,
      `${SATCA_PICKER_OWNING_SLICES.selectable}: the revealed archived row is selectable`,
    ).toHaveAttribute("aria-checked", "true");
    await expect(
      createButton,
      `${SATCA_PICKER_OWNING_SLICES.selectable}: Create is enabled for an archived spec`,
    ).toBeEnabled();
    await createButton.click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/benches/\\d+$`));

    // S001-O01: the bench is bound to the archived spec.
    const benches = await request.get(`/api/projects/${PROJECT_ID}/benches`);
    expect(benches.status()).toBe(200);
    const list = (await benches.json()) as Array<{ variant?: string; focusedSpecPath?: string }>;
    const created = list.find((b) => b.variant === "testbench");
    expect(
      created?.focusedSpecPath,
      `${SATCA_PICKER_OWNING_SLICES.selectable}: the bench is bound to the archived spec`,
    ).toMatch(new RegExp(`\\.specifications/${SATCA_ARCHIVED_SPEC_SLUG}/test-cases\\.json$`));

    // S001-O02: the panel indicates the focused spec is archived, read from the
    // bench's own workspace. Open the TestBench tab and switch to the Cases
    // review so the plan (and with it the lifecycle marker) has loaded.
    await page
      .getByRole("tablist")
      .getByRole("tab", { name: /^TestBench/ })
      .click();
    const panel = page.getByRole("tabpanel");
    await expect(panel).toBeVisible();
    await showTestBenchCasesView(page);
    await expect(
      panel.getByText(SATCA_ARCHIVED_SPEC_SLUG, { exact: true }),
      `${SATCA_PICKER_OWNING_SLICES.panel}: the archived spec is the focused spec in the header`,
    ).toBeVisible();
    await expect(
      panel.getByTestId("focused-spec-archived"),
      `${SATCA_PICKER_OWNING_SLICES.panel}: the panel indicates the focused spec is archived`,
    ).toHaveText("Archived");
  });
});
