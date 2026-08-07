import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  loadAppShell,
  readSpecManifest,
  registerFixtureProject,
  resetWithScenario,
} from "./_support/scenario.js";
import {
  SATCA_LIVE_PLAN,
  SATCA_LIVE_SPEC_SLUG,
  SATCA_RICH_MANIFEST,
  SATCA_RICH_PLAN,
  SATCA_RICH_SPEC_SLUG,
  SATCA_SUPERSEDED_PLAN,
  SATCA_SUPERSEDED_SPEC_SLUG,
  SATCA_UNRECOGNISED_MANIFEST_KEY,
  SATCA_WRITE_OWNING_SLICES,
  SATCA_WRITE_REASON,
} from "./_support/testbench-plan.js";

// E2E (#773): the integrated drift guard for the "archive or supersede a whole
// spec from the picker, and reverse either" journey (SATCA-TC-047/048/049/050
// S003+S004, SATCA-FR-020/FR-021/FR-028, SATCA-US-006/US-007). It runs against
// the BUILT app with a fixture repo carrying three live specs that differ only
// in what manifest they start with:
//   - the live spec has NO manifest, so archiving it must create a minimal one;
//   - the rich spec has a realistic product-dev manifest (stage tracking, id
//     counters, and a key Roubo has never heard of), so archiving it must merge
//     rather than serialize;
//   - the superseded spec is superseded and then restored.
//
// Every assertion about what landed is made against DISK (via the ROUBO_E2E-only
// /test/__read-spec-manifest tap), not against the UI that just wrote it: the
// whole point of the slice is what ends up in the reviewer's repository.
//
// TC-050's S001/S002 steps reverse CASE-level lifecycle actions, which are the
// parallel slice and are deliberately out of scope here; this spec covers S003
// and S004.

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";
const PROJECT_ID = "satca-tc-047-lifecycle-write";

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

test("SATCA-TC-047/048/049/050: archiving and superseding a spec write the manifest, preserve every foreign key, and reverse", async ({
  page,
  request,
}) => {
  await test.step("Precondition: enable the TestBench feature", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project with a manifest-less spec, a rich-manifest spec, and a third live spec", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      seedSpecs: [
        // No manifest at all: TC-048's precondition.
        { slug: SATCA_LIVE_SPEC_SLUG, testCases: SATCA_LIVE_PLAN },
        // A realistic product-dev manifest and no lifecycle record: TC-049's.
        {
          slug: SATCA_RICH_SPEC_SLUG,
          testCases: SATCA_RICH_PLAN,
          manifest: SATCA_RICH_MANIFEST,
        },
        { slug: SATCA_SUPERSEDED_SPEC_SLUG, testCases: SATCA_SUPERSEDED_PLAN },
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
  // (DialogTrigger) also carries role="dialog". The confirm step replaces the
  // picker body inside the SAME dialog, so its heading (which is the dialog's
  // accessible name) changes with it; each step is located by the name it then
  // carries, which is also the assertion that the confirm step is showing.
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  const archiveDialog = page.getByRole("dialog", { name: "Archive this specification" });
  const supersedeDialog = page.getByRole("dialog", { name: "Supersede this specification" });
  const revealControl = dialog.getByRole("button", { name: /^Show archived/ });
  const archivedRegion = dialog.locator('[aria-label="Archived specs"]');
  // A row in the picker's DEFAULT list, i.e. one that is not inside a disclosed
  // group. The archived group (and the all-passed one) is a role="group" child of
  // the selection group, so excluding those children is what distinguishes
  // "listed by default" from "revealed behind a control": once the reveal is on,
  // an archived row is still a visible radio, just not a default-list one.
  const defaultRow = (slug: string) =>
    dialog
      .locator('[role="radiogroup"] > div:not([role="group"])')
      .getByRole("radio", { name: new RegExp(`^${slug}`) });
  const archivedRow = (slug: string) =>
    archivedRegion.getByRole("radio", { name: new RegExp(`^${slug}`) });
  const actionsFor = (slug: string) => dialog.getByRole("button", { name: `Actions for ${slug}` });

  await test.step("Open the spec picker: all three specs are live", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(dialog).toBeVisible();
    await expect(defaultRow(SATCA_LIVE_SPEC_SLUG)).toBeVisible();
    await expect(defaultRow(SATCA_RICH_SPEC_SLUG)).toBeVisible();
    await expect(defaultRow(SATCA_SUPERSEDED_SPEC_SLUG)).toBeVisible();
    await expect(revealControl).toBeHidden();
  });

  // ── SATCA-TC-048: a spec folder with no manifest gets a minimal one ──────────
  await test.step("TC-048: archive the manifest-less spec -> a minimal manifest is created", async () => {
    const before = await readSpecManifest(request, {
      projectId: PROJECT_ID,
      slug: SATCA_LIVE_SPEC_SLUG,
    });
    expect(before.manifest, `${SATCA_WRITE_OWNING_SLICES.minimal}: precondition, no manifest`).toBe(
      null,
    );

    await actionsFor(SATCA_LIVE_SPEC_SLUG).click();
    await page.getByRole("menuitem", { name: /^Archive/ }).click();
    await expect(archiveDialog).toBeVisible();
    // The confirm step names the file it is about to change and says the change
    // is left uncommitted (the writer never invokes git).
    await expect(
      archiveDialog.getByText(`.specifications/${SATCA_LIVE_SPEC_SLUG}/manifest.json`),
    ).toBeVisible();
    await expect(archiveDialog.getByText(/Left uncommitted for you to review/)).toBeVisible();
    await archiveDialog.getByRole("button", { name: "Archive", exact: true }).click();

    // The row leaves the default list and joins the archived group.
    await expect(
      defaultRow(SATCA_LIVE_SPEC_SLUG),
      `${SATCA_WRITE_OWNING_SLICES.archive}: the archived spec leaves the default list`,
    ).toBeHidden();

    const after = await readSpecManifest(request, {
      projectId: PROJECT_ID,
      slug: SATCA_LIVE_SPEC_SLUG,
    });
    // S001-O01: a manifest is created in the spec folder.
    expect(after.manifest, `${SATCA_WRITE_OWNING_SLICES.minimal}: a manifest now exists`).not.toBe(
      null,
    );
    // S001-O02: it records the archived state and the folder slug.
    expect(after.manifest?.slug).toBe(SATCA_LIVE_SPEC_SLUG);
    expect(after.manifest?.lifecycle).toEqual({ archived: true });
    // S001-O03: it asserts nothing the application cannot know. No stage
    // progress, no id counters, no schema version: those are product-dev's.
    expect(
      Object.keys(after.manifest ?? {}).sort(),
      `${SATCA_WRITE_OWNING_SLICES.minimal}: the minimal manifest asserts only slug, lifecycle and timestamp`,
    ).toEqual(["lifecycle", "slug", "updated_at"]);
    // The case file was not touched.
    expect(after.casesChecksum).toBe(before.casesChecksum);
  });

  // ── SATCA-TC-050 S003: archiving a spec is reversible ────────────────────────
  await test.step("TC-050 S003: restore it -> the record is gone and it returns to the default list", async () => {
    await revealControl.click();
    await expect(archivedRow(SATCA_LIVE_SPEC_SLUG)).toBeVisible();
    await actionsFor(SATCA_LIVE_SPEC_SLUG).click();
    await page.getByRole("menuitem", { name: /^Restore/ }).click();

    // S003-O01: the spec returns to the default picker list.
    await expect(
      defaultRow(SATCA_LIVE_SPEC_SLUG),
      `${SATCA_WRITE_OWNING_SLICES.reverse}: the restored spec is back in the default list`,
    ).toBeVisible();

    const after = await readSpecManifest(request, {
      projectId: PROJECT_ID,
      slug: SATCA_LIVE_SPEC_SLUG,
    });
    expect(
      Object.prototype.hasOwnProperty.call(after.manifest ?? {}, "lifecycle"),
      `${SATCA_WRITE_OWNING_SLICES.reverse}: the lifecycle key is removed, not set false`,
    ).toBe(false);
  });

  // ── SATCA-TC-047 + TC-049: the merge-write ───────────────────────────────────
  await test.step("TC-047/049: archive the rich-manifest spec -> every foreign key survives and the case file is byte-identical", async () => {
    const before = await readSpecManifest(request, {
      projectId: PROJECT_ID,
      slug: SATCA_RICH_SPEC_SLUG,
    });
    expect(before.manifest?.[SATCA_UNRECOGNISED_MANIFEST_KEY]).toBeDefined();

    await actionsFor(SATCA_RICH_SPEC_SLUG).click();
    await page.getByRole("menuitem", { name: /^Archive/ }).click();
    await expect(archiveDialog).toBeVisible();
    await archiveDialog.getByLabel("Reason (optional)").fill(SATCA_WRITE_REASON);
    await archiveDialog.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(defaultRow(SATCA_RICH_SPEC_SLUG)).toBeHidden();

    const after = await readSpecManifest(request, {
      projectId: PROJECT_ID,
      slug: SATCA_RICH_SPEC_SLUG,
    });

    // TC-047 S001-O01: the manifest records the spec as archived.
    expect(
      after.manifest?.lifecycle,
      `${SATCA_WRITE_OWNING_SLICES.archive}: the manifest records the spec as archived`,
    ).toEqual({ archived: true, reason: SATCA_WRITE_REASON });
    // TC-047 S001-O02: the case file is byte-identical to before.
    expect(
      after.casesChecksum,
      `${SATCA_WRITE_OWNING_SLICES.archive}: the case file is byte-identical`,
    ).toBe(before.casesChecksum);

    // TC-049 S001-O01: every pre-existing key is still present and unchanged.
    for (const key of Object.keys(SATCA_RICH_MANIFEST)) {
      if (key === "updated_at") continue;
      expect(
        after.manifest?.[key],
        `${SATCA_WRITE_OWNING_SLICES.preserve}: key "${key}" survived the merge-write`,
      ).toEqual(SATCA_RICH_MANIFEST[key]);
    }
    // TC-049 S001-O02: the unrecognised custom key survived verbatim.
    expect(
      after.manifest?.[SATCA_UNRECOGNISED_MANIFEST_KEY],
      `${SATCA_WRITE_OWNING_SLICES.preserve}: the unrecognised key survived verbatim`,
    ).toEqual(SATCA_RICH_MANIFEST[SATCA_UNRECOGNISED_MANIFEST_KEY]);
    // TC-049 S001-O03: only the lifecycle record and the timestamp changed.
    expect(Object.keys(after.manifest ?? {}).sort()).toEqual(
      [...Object.keys(SATCA_RICH_MANIFEST), "lifecycle"].sort(),
    );
    expect(after.manifest?.updated_at).not.toBe(SATCA_RICH_MANIFEST.updated_at);
  });

  // ── SATCA-TC-050 S004: superseding a spec is reversible ──────────────────────
  await test.step("TC-050 S004: supersede the third spec from the project's other specs, then reverse it", async () => {
    await actionsFor(SATCA_SUPERSEDED_SPEC_SLUG).click();
    await page.getByRole("menuitem", { name: /^Supersede/ }).click();
    await expect(supersedeDialog).toBeVisible();

    // FR-028: the replacement is CHOSEN from the project's other specifications,
    // never typed. Confirm stays disabled until one is picked.
    await expect(
      supersedeDialog.getByRole("button", { name: "Supersede", exact: true }),
      `${SATCA_WRITE_OWNING_SLICES.supersede}: confirm is disabled until a target is chosen`,
    ).toBeDisabled();
    await supersedeDialog.getByRole("button", { name: /Choose a specification/ }).click();
    const options = page.getByRole("option");
    await expect(options.filter({ hasText: SATCA_LIVE_SPEC_SLUG })).toBeVisible();
    // The spec being superseded is not offered as its own replacement.
    await expect(options.filter({ hasText: SATCA_SUPERSEDED_SPEC_SLUG })).toHaveCount(0);
    await options.filter({ hasText: SATCA_LIVE_SPEC_SLUG }).click();
    await supersedeDialog.getByRole("button", { name: "Supersede", exact: true }).click();

    await expect(defaultRow(SATCA_SUPERSEDED_SPEC_SLUG)).toBeHidden();
    const superseded = await readSpecManifest(request, {
      projectId: PROJECT_ID,
      slug: SATCA_SUPERSEDED_SPEC_SLUG,
    });
    expect(
      superseded.manifest?.lifecycle,
      `${SATCA_WRITE_OWNING_SLICES.supersede}: the pointer is recorded on disk`,
    ).toEqual({ archived: true, supersededBy: SATCA_LIVE_SPEC_SLUG });

    // Reverse it from the same surface.
    await expect(archivedRegion).toBeVisible();
    await actionsFor(SATCA_SUPERSEDED_SPEC_SLUG).click();
    await page.getByRole("menuitem", { name: /^Restore/ }).click();

    // S004-O01: the spec returns to the default list with no superseding pointer.
    await expect(
      defaultRow(SATCA_SUPERSEDED_SPEC_SLUG),
      `${SATCA_WRITE_OWNING_SLICES.reverse}: the restored spec is back in the default list`,
    ).toBeVisible();
    const restored = await readSpecManifest(request, {
      projectId: PROJECT_ID,
      slug: SATCA_SUPERSEDED_SPEC_SLUG,
    });
    expect(
      Object.prototype.hasOwnProperty.call(restored.manifest ?? {}, "lifecycle"),
      `${SATCA_WRITE_OWNING_SLICES.reverse}: the superseding pointer is gone from the file`,
    ).toBe(false);
  });
});
