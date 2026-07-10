import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
  seedSpecResults,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  OWNING_SLICES_TSPF_TC011,
  TSPF_ACTIVE_PLAN,
  TSPF_ACTIVE_SPEC_SLUG,
  TSPF_ATTENTION_PLAN,
  TSPF_ATTENTION_SPEC_SLUG,
  TSPF_PASSED_PLAN,
  TSPF_PASSED_SPEC_SLUG,
} from "./_support/testbench-plan.js";

// E2E (#487): the authoritative `e2e_flow` drift guard for TSPF-TC-011, the
// "change an active TestBench's focused spec through the identical partitioned
// picker" journey (TSPF-US-003, TSPF-FR-005). It is the re-point sibling of the
// #486 create-flow guard (TSPF-TC-010) and mirrors the TC-007 re-point spec's
// structure: labelled `test.step`s, an owning-slice map for failure localization,
// plan projections seeded into a `git init`-ed fixture repo, and assertions
// against the BUILT app.
//
// The wrinkle over TC-007 is asserting the PARTITION. Both the create picker
// (#418) and the re-point picker (#423) render the SAME SpecPickerModal off the
// SAME endpoint (`GET /:projectId/testbench/specs`), whose per-spec
// `verification.classification` (owned server-side by #483) drives the split:
// needs-attention specs fill the prominent main space, all-passed specs sit behind
// a single collapsed disclosure. This spec drives BOTH pickers on ONE project with
// ONE repo state and proves they render the IDENTICAL partition, then re-points to
// a needs-attention spec and proves the previously focused spec's results survive.
//
// Classification is data-driven: a spec is "all-passed" only when a readable,
// schema-valid, plan-hash-matching results sidecar with every case passed sits in
// the project repo. `registerFixtureProject`'s `seedSpecs` writes only the plan, so
// the reusable `seedSpecResults` harness seam (a ROUBO_E2E-gated write through the
// real store) seeds the passing sidecars: a FULL all-pass for the completed spec
// (all-passed group) and a PARTIAL all-pass for one needs-attention spec (so its
// "1 of 3 passed" summary is real, not merely "no results yet"). Per-spec result
// isolation is enforced server-side (results are keyed by the focused spec's slug
// under the bench's own worktree; re-point only swaps `bench.focusedSpecPath`), so
// this spec proves that contract rather than implementing it. Unlike #483's unit
// tests, this asserts the integrated journey; each step is wrapped in a labelled
// `test.step` so a failure localises the diverging step, reports expected-vs-actual
// at that step, and names the owning slice (AC5, the failure-output contract).

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";
const PROJECT_ID = "tspf-tc011-partitioned-picker";

// The single active-spec case (+ observation) the test records a result against.
const ACTIVE_CASE_ID = TSPF_ACTIVE_PLAN.cases[0].id;
const ACTIVE_OBSERVATION_ID = TSPF_ACTIVE_PLAN.cases[0].steps[0].observations[0].id;
// The attention spec's first case: seeded passed (1 of 3), and the first case
// listed once the TestBench re-points to it.
const ATTENTION_CASE_ID = TSPF_ATTENTION_PLAN.cases[0].id;

const ACTIVE_PATH_RE = new RegExp(`\\.specifications/${TSPF_ACTIVE_SPEC_SLUG}/test-cases\\.json$`);
const ATTENTION_PATH_RE = new RegExp(
  `\\.specifications/${TSPF_ATTENTION_SPEC_SLUG}/test-cases\\.json$`,
);

// The per-row pass-state summaries discovery derives from the seeded sidecars
// (deriveSpecSummary): the active spec has no project-repo sidecar, the attention
// spec has one of three cases passed, the passed spec has all cases passed.
const ACTIVE_SUMMARY = "no results yet";
const ATTENTION_SUMMARY = `1 of ${TSPF_ATTENTION_PLAN.cases.length} passed`;
const PASSED_SUMMARY = `All ${TSPF_PASSED_PLAN.cases.length} passed`;

// The captured, mode-independent partition signature: the needs-attention slugs in
// the main space (the only radios mounted while the disclosure is collapsed) and
// the all-passed count in the disclosure. Excludes the re-point-only Active badge
// so the create and re-point signatures can be compared for equality.
interface PartitionSignature {
  needsAttention: string[];
  allPassedCount: number;
}

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), OWNING_SLICES_TSPF_TC011.enable).toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(
    res.status(),
    `${OWNING_SLICES_TSPF_TC011.enable}: PUT /api/settings testBench.enabled`,
  ).toBe(200);
  const body = (await res.json()) as { testBench?: { enabled?: boolean } };
  expect(body.testBench?.enabled, OWNING_SLICES_TSPF_TC011.enable).toBe(true);
}

async function gotoBenchList(page: Page, projectId: string): Promise<void> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
}

// Read the testbench plan + results for a bench. The panel renders off this same
// payload, so it is the canonical evidence for the per-spec result isolation
// assertions: results are keyed by case id under the currently focused spec.
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

// Poll the plan endpoint until the newly created bench's worktree is provisioned
// and its focused plan is readable (200 with the expected slug). The create flow
// provisions the spec-bound worktree, but the plan/mark routes read `.specifications/
// <slug>/test-cases.json` from that worktree, so a mark issued before provisioning
// settles can 404. Gating the first result-mark on this readiness check keeps the
// journey deterministic without coupling to provisioning internals.
async function waitForFocusedPlan(
  request: APIRequestContext,
  projectId: string,
  benchId: number,
  expectedSlug: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get(
          `/api/projects/${projectId}/benches/${benchId}/testbench/plan`,
        );
        if (res.status() !== 200) return null;
        const body = (await res.json()) as { plan?: { specSlug?: string } };
        return body.plan?.specSlug ?? null;
      },
      { timeout: 15_000, intervals: [100, 200, 300, 500] },
    )
    .toBe(expectedSlug);
}

// Capture the collapsed-state partition signature from an open picker dialog. The
// disclosure is collapsed here, so the only mounted radios are the needs-attention
// rows; the slug is the first text line of each row (the Active badge, when
// present, follows the slug on the same line and is dropped by the slug regex).
async function capturePartition(dialog: Locator): Promise<PartitionSignature> {
  // `allInnerTexts()` is a non-retrying snapshot: it reads whatever radios are
  // mounted right now. On a picker's first (uncached) open the dialog is visible
  // while `useTestbenchSpecs` is still fetching (SpecPickerModal renders a loading
  // branch before the rows + disclosure mount), so wait for the first discovered
  // row to mount before snapshotting; otherwise the read can race the fetch and
  // capture an empty needs-attention set while the auto-waiting disclosure read
  // below still resolves to the loaded count, yielding an inconsistent signature.
  await dialog.getByRole("radio").first().waitFor();
  const rowTexts = await dialog.getByRole("radio").allInnerTexts();
  const needsAttention = rowTexts
    .map(
      (t) =>
        t
          .split("\n")[0]
          .trim()
          .match(/^[a-z][a-z0-9-]*/)?.[0] ?? "",
    )
    .filter((slug) => slug.length > 0)
    .sort();
  const disclosureName =
    (await dialog.getByRole("button", { name: /All passed/ }).textContent()) ?? "";
  const countMatch = disclosureName.match(/(\d+)\s*spec/);
  return { needsAttention, allPassedCount: countMatch ? Number(countMatch[1]) : 0 };
}

// Assert one picker renders the expected partition and return its signature. The
// same expected values are asserted for both the create and the re-point picker,
// so calling this on both is what proves the partition is identical; the returned
// signatures are additionally compared for equality (AC2). `activeSlug` is set only
// in re-point mode, where the focused spec's row carries the Active badge.
async function assertPartition(
  dialog: Locator,
  opts: { activeSlug?: string } = {},
): Promise<PartitionSignature> {
  const signature = await capturePartition(dialog);

  // Needs-attention specs fill the prominent main space, each with its per-row
  // pass-state summary.
  const activeRow = dialog.getByRole("radio", { name: new RegExp(`^${TSPF_ACTIVE_SPEC_SLUG}`) });
  await expect(
    activeRow,
    `${OWNING_SLICES_TSPF_TC011.partition}: active spec in the needs-attention main space`,
  ).toBeVisible();
  await expect(
    activeRow.getByText(ACTIVE_SUMMARY),
    `${OWNING_SLICES_TSPF_TC011.partition}: active spec summary is "${ACTIVE_SUMMARY}"`,
  ).toBeVisible();

  const attentionRow = dialog.getByRole("radio", {
    name: new RegExp(`^${TSPF_ATTENTION_SPEC_SLUG}`),
  });
  await expect(
    attentionRow,
    `${OWNING_SLICES_TSPF_TC011.partition}: attention spec in the needs-attention main space`,
  ).toBeVisible();
  await expect(
    attentionRow.getByText(ATTENTION_SUMMARY),
    `${OWNING_SLICES_TSPF_TC011.partition}: attention spec summary is "${ATTENTION_SUMMARY}"`,
  ).toBeVisible();

  // The all-passed spec is hidden behind the collapsed disclosure (its row is not
  // mounted until the disclosure expands).
  const passedRow = dialog.getByRole("radio", { name: new RegExp(`^${TSPF_PASSED_SPEC_SLUG}`) });
  await expect(
    passedRow,
    `${OWNING_SLICES_TSPF_TC011.partition}: all-passed spec hidden while the disclosure is collapsed`,
  ).toBeHidden();

  const disclosure = dialog.getByRole("button", { name: /All passed/ });
  await expect(
    disclosure,
    `${OWNING_SLICES_TSPF_TC011.partition}: the all-passed disclosure is present`,
  ).toBeVisible();
  await expect(
    disclosure,
    `${OWNING_SLICES_TSPF_TC011.partition}: the disclosure is collapsed by default`,
  ).toHaveAttribute("aria-expanded", "false");
  await expect(
    disclosure,
    `${OWNING_SLICES_TSPF_TC011.partition}: the disclosure names the all-passed count (1 spec)`,
  ).toHaveAccessibleName(/All passed.*\b1 spec\b/);

  // Re-point only: the focused spec's row carries the Active badge. This is the
  // one intended difference from the create picker (an addition, not a re-grouping)
  // and never changes which group a spec falls into.
  if (opts.activeSlug) {
    await expect(
      dialog
        .getByRole("radio", { name: new RegExp(`^${opts.activeSlug}`) })
        .getByText("Active", { exact: true }),
      `${OWNING_SLICES_TSPF_TC011.identicalPartition}: focused spec carries the Active badge`,
    ).toBeVisible();
  }

  // Expand the disclosure: the all-passed spec appears with its "All M passed"
  // summary. Collapse again to restore the default (collapsed) partition.
  await disclosure.click();
  await expect(
    disclosure,
    `${OWNING_SLICES_TSPF_TC011.partition}: the disclosure expands on press`,
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    passedRow,
    `${OWNING_SLICES_TSPF_TC011.partition}: all-passed spec revealed inside the disclosure`,
  ).toBeVisible();
  await expect(
    passedRow.getByText(PASSED_SUMMARY),
    `${OWNING_SLICES_TSPF_TC011.partition}: all-passed spec summary is "${PASSED_SUMMARY}"`,
  ).toBeVisible();
  await disclosure.click();
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");

  return signature;
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TSPF-TC-011: change an active TestBench's focused spec through the identical partitioned picker", async ({
  page,
  request,
}) => {
  // ── Preconditions: feature enabled, project carrying both classifications ─────
  await test.step("Precondition: enable the TestBench feature (#414)", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project whose repo carries both needs-attention and all-passed specs", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions; the server
      // pins worktreeSource to local HEAD so no origin remote is needed.
      gitInit: true,
      seedSpecs: [
        { slug: TSPF_ACTIVE_SPEC_SLUG, testCases: TSPF_ACTIVE_PLAN },
        { slug: TSPF_ATTENTION_SPEC_SLUG, testCases: TSPF_ATTENTION_PLAN },
        { slug: TSPF_PASSED_SPEC_SLUG, testCases: TSPF_PASSED_PLAN },
      ],
    });
    expect(projectId).toBe(PROJECT_ID);

    // Seed the passing sidecars into the project repo (where discovery reads) so
    // classification populates BOTH partition groups: a partial all-pass keeps the
    // attention spec needs-attention with a "1 of 3 passed" summary; a full all-pass
    // moves the passed spec into the all-passed disclosure. The active spec is left
    // with no sidecar ("no results yet"). The active-spec result recorded later is
    // written to the bench WORKTREE, so this project-repo partition is unchanged
    // between the create and re-point pickers.
    await seedSpecResults(request, {
      projectId: PROJECT_ID,
      slug: TSPF_ATTENTION_SPEC_SLUG,
      passCaseIds: [ATTENTION_CASE_ID],
    });
    await seedSpecResults(request, { projectId: PROJECT_ID, slug: TSPF_PASSED_SPEC_SLUG });
  });

  await loadAppShell(page);
  await test.step("Precondition: on the bench list view for the project", async () => {
    await gotoBenchList(page, PROJECT_ID);
    await expect(page.getByText("Bench 1")).toBeVisible();
    await expect(page.getByText("Available").first()).toBeVisible();
  });

  // ── The create picker's partition (AC2 baseline for the identity comparison) ──
  const createDialog = page.getByRole("dialog", { name: "Create a TestBench" });
  let createSignature: PartitionSignature = { needsAttention: [], allPassedCount: 0 };
  await test.step("Open the create picker; capture the partition it renders on this repo state (#483)", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(
      createDialog,
      `${OWNING_SLICES_TSPF_TC011.repointAction}: the create spec-picker opens`,
    ).toBeVisible();
    createSignature = await assertPartition(createDialog);
    // The captured baseline: exactly the two needs-attention specs in the main
    // space, exactly one spec behind the all-passed disclosure.
    expect(
      createSignature,
      `${OWNING_SLICES_TSPF_TC011.partition}: create picker partitions two needs-attention + one all-passed`,
    ).toEqual({
      needsAttention: [TSPF_ACTIVE_SPEC_SLUG, TSPF_ATTENTION_SPEC_SLUG].sort(),
      allPassedCount: 1,
    });
  });

  // ── Precondition: create the TestBench bound to the active spec ───────────────
  await test.step("Precondition: create a TestBench bound to the active (needs-attention) spec (#416/#418)", async () => {
    const activeRow = createDialog.getByRole("radio", {
      name: new RegExp(`^${TSPF_ACTIVE_SPEC_SLUG}`),
    });
    await activeRow.click();
    const createButton = createDialog.getByRole("button", { name: "Create TestBench" });
    await expect(createButton).toBeEnabled();
    await createButton.click();
    await expect(
      createDialog,
      `${OWNING_SLICES_TSPF_TC011.createBinding}: modal closes on create`,
    ).toBeHidden();
    await expect(
      page,
      `${OWNING_SLICES_TSPF_TC011.createBinding}: navigates to the new bench's detail view`,
    ).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/benches/\\d+$`));
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
      `${OWNING_SLICES_TSPF_TC011.createBinding}: bench bound to the active spec's test-cases.json`,
    ).toMatch(ACTIVE_PATH_RE);
  });

  const benchId = Number(new URL(page.url()).pathname.split("/").pop());
  expect(Number.isInteger(benchId), "resolved a numeric bench id from the detail URL").toBe(true);

  // ── Precondition: record a result against the active spec (in the worktree) ───
  await test.step("Precondition: record a result against the active spec (mark its observation pass)", async () => {
    // Wait for the spec-bound worktree to finish provisioning so its plan (and the
    // mark route that reads it) is readable before the first mark.
    await waitForFocusedPlan(request, PROJECT_ID, benchId, TSPF_ACTIVE_SPEC_SLUG);
    const res = await request.put(
      `/api/projects/${PROJECT_ID}/benches/${benchId}/testbench/cases/${ACTIVE_CASE_ID}/observations/${ACTIVE_OBSERVATION_ID}`,
      { data: { result: "pass" } },
    );
    expect(
      res.status(),
      `${OWNING_SLICES_TSPF_TC011.reviewPanel}: marking the active observation pass returns 200`,
    ).toBe(200);
    const planAndResults = await fetchPlanAndResults(request, PROJECT_ID, benchId);
    expect(planAndResults.plan.specSlug).toBe(TSPF_ACTIVE_SPEC_SLUG);
    expect(
      planAndResults.results?.caseResults[ACTIVE_CASE_ID],
      `${OWNING_SLICES_TSPF_TC011.reviewPanel}: the active spec's case carries a recorded result`,
    ).toBeTruthy();
  });

  // ── Open the TestBench tab; confirm the recorded active-spec result loads ─────
  const tablist = page.getByRole("tablist");
  await test.step("Open the TestBench tab; the recorded active-spec result is reflected (#416)", async () => {
    // The result was recorded out-of-band via the API after the panel already
    // rendered, so reload to fetch the panel's plan + results fresh.
    await page.reload();
    await tablist.getByRole("tab", { name: /^TestBench/ }).click();
    const panel = page.getByRole("tabpanel");
    await expect(panel).toBeVisible();
    await showTestBenchCasesView(page);
    await expect(
      panel.getByText(TSPF_ACTIVE_SPEC_SLUG, { exact: true }),
      `${OWNING_SLICES_TSPF_TC011.reviewPanel}: the active spec is focused in the header`,
    ).toBeVisible();
    await expect(
      panel.getByRole("img", { name: /Overall: 1 passed.*of 1/ }),
      `${OWNING_SLICES_TSPF_TC011.reviewPanel}: the active spec's rollup shows 1 passed of 1`,
    ).toBeVisible();
  });

  // ── S001+S002 (AC1/AC2): re-point picker renders the IDENTICAL partition ──────
  const repointDialog = page.getByRole("dialog", { name: "Change focused spec" });
  await test.step("S001+S002 (AC1/AC2): 'Change focused spec' opens the re-point picker with the identical partition (#483)", async () => {
    await page.getByRole("button", { name: "Change focused spec" }).click();
    await expect(
      repointDialog,
      `${OWNING_SLICES_TSPF_TC011.repointAction}: the re-point picker opens`,
    ).toBeVisible();
    // AC1: re-point title + copy.
    await expect(
      repointDialog.getByRole("heading", { name: "Change focused spec" }),
      `${OWNING_SLICES_TSPF_TC011.repointAction}: the picker shows the re-point title`,
    ).toBeVisible();
    await expect(
      repointDialog.getByRole("button", { name: /Re-point TestBench/ }),
      `${OWNING_SLICES_TSPF_TC011.repointAction}: the picker is in re-point mode`,
    ).toBeVisible();
    // AC2: the same partition the create picker rendered, with the active spec now
    // flagged. The returned signature must equal the create picker's, byte for byte.
    const repointSignature = await assertPartition(repointDialog, {
      activeSlug: TSPF_ACTIVE_SPEC_SLUG,
    });
    expect(
      repointSignature,
      `${OWNING_SLICES_TSPF_TC011.identicalPartition}: re-point partition is identical to the create picker's`,
    ).toEqual(createSignature);
  });

  // ── S003 (AC2/AC3): re-point to a needs-attention spec, results preserved ─────
  await test.step("S003 (AC3): select a needs-attention spec, re-point -> header shows it, its plan loads (#483)", async () => {
    const attentionRow = repointDialog.getByRole("radio", {
      name: new RegExp(`^${TSPF_ATTENTION_SPEC_SLUG}`),
    });
    await attentionRow.click();
    await expect(
      attentionRow,
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: attention row highlighted on selection`,
    ).toHaveAttribute("aria-checked", "true");
    const confirm = repointDialog.getByRole("button", { name: /Re-point TestBench/ });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(
      repointDialog,
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: modal closes on confirm`,
    ).toBeHidden();
    const panel = page.getByRole("tabpanel");
    await expect(
      panel.getByText(ATTENTION_PATH_RE),
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: header shows the attention spec as focused`,
    ).toBeVisible();
    // The panel reloads the newly focused plan from the worktree: the attention
    // spec's case is listed and the active spec's case is gone. The attention
    // spec's worktree carries no results (its seeded sidecar lives only in the
    // project repo, for discovery), so it starts fresh at 0 of 3.
    await expect(
      panel.getByText(ATTENTION_CASE_ID),
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: the attention spec's plan loaded (its case is listed)`,
    ).toBeVisible();
    await expect(
      panel.getByText(ACTIVE_CASE_ID),
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: the active spec's case no longer listed`,
    ).toBeHidden();
    await expect(
      panel.getByRole("img", { name: /Overall: 0 passed.*of 3/ }),
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: the attention spec starts with no worktree results`,
    ).toBeVisible();
  });

  await test.step("S003 (AC3): re-point back -> the previous spec's results are preserved intact (#483)", async () => {
    await page.getByRole("button", { name: "Change focused spec" }).click();
    await expect(repointDialog).toBeVisible();
    // The attention spec is now the active (focused) spec.
    await expect(
      repointDialog
        .getByRole("radio", { name: new RegExp(`^${TSPF_ATTENTION_SPEC_SLUG}`) })
        .getByText("Active", { exact: true }),
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: attention spec shown active after the re-point`,
    ).toBeVisible();
    const activeRow = repointDialog.getByRole("radio", {
      name: new RegExp(`^${TSPF_ACTIVE_SPEC_SLUG}`),
    });
    await activeRow.click();
    await repointDialog.getByRole("button", { name: /Re-point TestBench/ }).click();
    await expect(repointDialog).toBeHidden();

    const panel = page.getByRole("tabpanel");
    await expect(
      panel.getByText(ACTIVE_PATH_RE),
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: header shows the active spec again after switching back`,
    ).toBeVisible();
    // The previously recorded result is fully preserved (not lost by the re-point
    // round-trip): the rollup shows 1 passed of 1 and the case still reads Passed.
    await expect(
      panel.getByRole("img", { name: /Overall: 1 passed.*of 1/ }),
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: the active spec's recorded result preserved (1 passed of 1)`,
    ).toBeVisible();
    await expect(
      panel.getByText("Passed").first(),
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: the active spec's case still shows Passed after the round-trip`,
    ).toBeVisible();
    // Server-side isolation: the active spec's result set carries its own case id
    // and none of the attention spec's case ids.
    const planAndResults = await fetchPlanAndResults(request, PROJECT_ID, benchId);
    expect(planAndResults.plan.specSlug).toBe(TSPF_ACTIVE_SPEC_SLUG);
    expect(
      planAndResults.results?.caseResults[ACTIVE_CASE_ID],
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: the active spec's result still present after the round-trip`,
    ).toBeTruthy();
    expect(
      Object.keys(planAndResults.results?.caseResults ?? {}),
      `${OWNING_SLICES_TSPF_TC011.repointConfirm}: the active spec's result set contains none of the attention spec's case ids`,
    ).not.toContain(ATTENTION_CASE_ID);
  });
});
