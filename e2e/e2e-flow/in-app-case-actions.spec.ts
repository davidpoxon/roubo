import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  inspectBenchGit,
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  SATCA_TC058_CASE_FILE_PATH,
  SATCA_TC058_EXPECTED_ADDED_LINES,
  SATCA_TC058_EXPECTED_REMOVED_LINES,
  SATCA_TC058_LIVE_PLAN,
  SATCA_TC058_OWNING_SLICES,
  SATCA_TC058_REASON,
  SATCA_TC058_RETIRE_CASE_ID,
  SATCA_TC058_SPEC_SLUG,
  SATCA_TC058_UNTOUCHED_CASE_IDS,
} from "./_support/testbench-plan.js";

// E2E (#779): the integrated drift guard for the IN-APP ACTIONS journey
// (SATCA-TC-058, SATCA-FR-019/FR-021, SATCA-NFR-001, SATCA-US-006/US-007). It
// runs against the BUILT app and proves the one thing no single slice can prove
// on its own: retiring a case through the panel writes a change that a reviewer
// can read as an ordinary uncommitted git diff, and that restoring reverses it
// exactly.
//
// It is the mirror image of SATCA-TC-010's journey (#776,
// case-lifecycle-format.spec.ts), which drives the READ direction: a retirement
// authored by hand in the case file, read end to end by the app. This one drives
// the WRITE direction and then inspects the result from OUTSIDE the app, which is
// what S002 asks for.
//
// The git assertions are the reason this spec exists, and they need a seam the
// harness did not have. The existing disk taps read file CONTENT, which can say
// what a file now holds but not "exactly one file is modified" or "nothing has
// been committed". `GET /test/__inspect-bench-git` (#779) supplies those, rooted
// at the bench's own worktree (#493), which is exactly where the live lifecycle
// write lands. The fixture is registered with `gitInit: true`, so the seeded plan
// rides into an initial commit and the worktree starts genuinely clean.
//
// Steps mirror SATCA-TC-058 one for one: S001 retires a case from the panel with
// a reason, S002 inspects the working tree from outside, S003 reverses the
// retirement. Each assertion carries the owning slice from this unit's blocked-by
// set (#767, #772, #773, #774, #775, #781) so an integrated failure is
// attributable to a slice rather than to "the journey".
//
// Out of scope, deliberately: any single slice's internals. The file-authored
// READ path is #776's journey, the SPEC-level lifecycle write is #773's, and the
// replacement picker is #774's.

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";
const PROJECT_ID = "satca-tc-058-in-app-actions";

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body.
  const current = await request.get("/api/settings");
  expect(current.status(), `${SATCA_TC058_OWNING_SLICES.enable}: read settings`).toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(
    res.status(),
    `${SATCA_TC058_OWNING_SLICES.enable}: PUT /api/settings testBench.enabled`,
  ).toBe(200);
}

// Create a spec-bound TestBench through the real empty-slot create flow and
// return its id, which the git tap addresses.
async function createSpecBoundBench(page: Page, projectId: string): Promise<number> {
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText("Bench 1")).toBeVisible();

  await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
  await page.getByRole("button", { name: "Create a TestBench" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });
  await expect(
    dialog,
    `${SATCA_TC058_OWNING_SLICES.create}: spec-picker modal opens`,
  ).toBeVisible();
  await dialog.getByRole("radio", { name: new RegExp(`^${SATCA_TC058_SPEC_SLUG}`) }).click();
  await dialog.getByRole("button", { name: "Create TestBench" }).click();
  await expect(dialog, `${SATCA_TC058_OWNING_SLICES.create}: modal closes on Create`).toBeHidden();
  await expect(
    page,
    `${SATCA_TC058_OWNING_SLICES.create}: navigates to the new bench's detail view`,
  ).toHaveURL(new RegExp(`/projects/${projectId}/benches/\\d+$`));

  const match = page.url().match(/\/benches\/(\d+)$/);
  const benchId = match ? Number(match[1]) : Number.NaN;
  expect(
    Number.isInteger(benchId),
    `${SATCA_TC058_OWNING_SLICES.create}: bench id resolvable from the URL`,
  ).toBe(true);
  return benchId;
}

// Open the bench's TestBench tab on the Cases review. The view toggle opens on
// the verify-gate "Batches" surface by default (#359), and this journey acts on
// the live case list, the case detail pane, and the archived section.
async function openCasesReview(page: Page): Promise<void> {
  await page
    .getByRole("tablist")
    .getByRole("tab", { name: /^TestBench/ })
    .click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await showTestBenchCasesView(page);
}

// The `+` / `-` lines of a unified diff, with the `+++` / `---` file headers
// dropped. Hunk headers and context lines carry no change, so only these two
// lists can express "the diff shows only the added lifecycle record".
function diffChangedLines(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added, removed };
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("SATCA-TC-058: retiring a case in the application produces a reviewable, uncommitted change that reverses", async ({
  page,
  request,
}) => {
  let benchId = 0;
  let baselineHeadSha = "";

  await test.step("Precondition: enable the TestBench feature", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project carrying a discoverable spec whose cases are all live", async () => {
    const { projectId } = await registerFixtureProject(request, {
      projectId: PROJECT_ID,
      // git init + commit so a real spec-bound worktree provisions on Create AND
      // the seeded plan is already committed. Both matter here: the worktree is
      // where the in-app write lands (#493), and the commit is what makes "the
      // working tree is clean" a real starting point rather than an artefact of
      // an unversioned fixture.
      gitInit: true,
      seedSpecs: [{ slug: SATCA_TC058_SPEC_SLUG, testCases: SATCA_TC058_LIVE_PLAN }],
    });
    expect(projectId).toBe(PROJECT_ID);
  });

  await loadAppShell(page);

  await test.step("Precondition: create a spec-bound TestBench and confirm all three cases are live", async () => {
    benchId = await createSpecBoundBench(page, PROJECT_ID);
    await openCasesReview(page);
    const panel = page.getByRole("tabpanel");
    for (const id of [SATCA_TC058_RETIRE_CASE_ID, ...SATCA_TC058_UNTOUCHED_CASE_IDS]) {
      await expect(
        panel.getByTestId("case-row").filter({ hasText: id }),
        `${SATCA_TC058_OWNING_SLICES.live}: ${id} is live in the case list before any action`,
      ).toBeVisible();
    }
    // Nothing is archived yet: absence of a lifecycle block IS the live state.
    await expect(
      panel.getByTestId("archived-cases"),
      `${SATCA_TC058_OWNING_SLICES.live}: no archived section before any lifecycle record exists`,
    ).toHaveCount(0);
  });

  await test.step("Precondition: the bench's working tree is clean before anything is retired", async () => {
    // The baseline S002 is measured against. Asserted, not assumed: if the
    // worktree already carried a modification, "exactly one file is modified"
    // after the retirement would prove nothing about the retirement.
    const git = await inspectBenchGit(request, { projectId: PROJECT_ID, benchId });
    expect(
      git.modified,
      `${SATCA_TC058_OWNING_SLICES.clean}: no tracked file is modified before the retirement`,
    ).toEqual([]);
    expect(
      git.untracked,
      `${SATCA_TC058_OWNING_SLICES.clean}: no untracked file is present before the retirement`,
    ).toEqual([]);
    baselineHeadSha = git.headSha;
    expect(
      baselineHeadSha,
      `${SATCA_TC058_OWNING_SLICES.clean}: the worktree has a commit to be dirty against`,
    ).not.toBe("");
  });

  const panel = page.getByRole("tabpanel");

  // ── S001: retire a case from the panel, giving a reason ──────────────────────
  await test.step("S001: retire a case from the panel, giving a reason", async () => {
    await panel.getByTestId("case-row").filter({ hasText: SATCA_TC058_RETIRE_CASE_ID }).click();

    const retireToggle = panel.getByTestId("case-retire-open");
    await expect(
      retireToggle,
      `${SATCA_TC058_OWNING_SLICES.controls}: the Retire control is offered on the selected live case`,
    ).toBeVisible();
    await retireToggle.click();

    const retirePanel = panel.getByTestId("case-retire-panel");
    await expect(
      retirePanel,
      `${SATCA_TC058_OWNING_SLICES.controls}: the retire disclosure opens`,
    ).toBeVisible();

    // The reason is required: submitting is refused until one is typed, which is
    // what makes "giving a reason" part of the action rather than an optional
    // afterthought.
    await expect(
      panel.getByTestId("case-retire-submit"),
      `${SATCA_TC058_OWNING_SLICES.controls}: retiring is refused until a reason is given`,
    ).toBeDisabled();

    await panel.getByTestId("case-retire-reason").fill(SATCA_TC058_REASON);
    await panel.getByTestId("case-retire-submit").click();
  });

  await test.step("S001-O01: the panel updates immediately", async () => {
    // No reload anywhere in this step. "Immediately" means the open panel
    // reflects the write, not that the state survives a refetch.
    //
    // Assert the POSITIVE control first: an untouched case still being on screen
    // proves the live list has rendered, which is what makes the absence below
    // meaningful rather than a race against a list that has not painted yet.
    await expect(
      panel.getByTestId("case-row").filter({ hasText: SATCA_TC058_UNTOUCHED_CASE_IDS[0] }),
      `${SATCA_TC058_OWNING_SLICES.panel}: the untouched ${SATCA_TC058_UNTOUCHED_CASE_IDS[0]} is still live`,
    ).toBeVisible();
    await expect(
      panel.getByTestId("case-row").filter({ hasText: SATCA_TC058_RETIRE_CASE_ID }),
      `${SATCA_TC058_OWNING_SLICES.panel}: ${SATCA_TC058_RETIRE_CASE_ID} leaves the live case list without a reload`,
    ).toHaveCount(0);

    await expect(
      panel.getByTestId("archived-cases"),
      `${SATCA_TC058_OWNING_SLICES.panel}: the archived section appears once a case is retired`,
    ).toBeVisible();
    await expect(
      panel.getByTestId(`archived-case-${SATCA_TC058_RETIRE_CASE_ID}`),
      `${SATCA_TC058_OWNING_SLICES.panel}: ${SATCA_TC058_RETIRE_CASE_ID} is shown as Retired`,
    ).toContainText("Retired");
    await expect(
      panel.getByTestId(`archived-reason-${SATCA_TC058_RETIRE_CASE_ID}`),
      `${SATCA_TC058_OWNING_SLICES.write}: the reason just given is shown verbatim`,
    ).toHaveText(SATCA_TC058_REASON);
  });

  // ── S002: inspect the working tree outside the application ───────────────────
  await test.step("S002: inspect the working tree outside the application", async () => {
    const git = await inspectBenchGit(request, { projectId: PROJECT_ID, benchId });

    await test.step("S002-O01: exactly one file is modified", async () => {
      expect(
        git.modified,
        `${SATCA_TC058_OWNING_SLICES.scope}: the retirement modifies the spec's case file and nothing else`,
      ).toEqual([SATCA_TC058_CASE_FILE_PATH]);
      // A new file left beside it would be just as much of a surprise to the
      // reviewer as a second modified one, so the absence is asserted too.
      expect(
        git.untracked,
        `${SATCA_TC058_OWNING_SLICES.scope}: the retirement leaves no new file behind`,
      ).toEqual([]);
    });

    await test.step("S002-O02: the diff shows only the added lifecycle record", async () => {
      const { added, removed } = diffChangedLines(git.diff);
      expect(
        added,
        `${SATCA_TC058_OWNING_SLICES.diff}: the only added lines are the lifecycle record (and the comma its insertion requires)`,
      ).toEqual(SATCA_TC058_EXPECTED_ADDED_LINES);
      expect(
        removed,
        `${SATCA_TC058_OWNING_SLICES.diff}: nothing is removed but the punctuation the insertion displaced`,
      ).toEqual(SATCA_TC058_EXPECTED_REMOVED_LINES);
      // Shape of the diff, not just its content: one file, one contiguous hunk.
      // A second hunk would mean the write reached a second place in the
      // document even if the lines it added there happened to look the same.
      // (Neighbouring case ids DO appear in the diff, as context lines around
      // the hunk. That is the reviewer's context, not a change, which is why the
      // `+`/`-` lists above are the thing asserted rather than the raw text.)
      expect(
        git.diff.split("\n").filter((line) => line.startsWith("diff --git")),
        `${SATCA_TC058_OWNING_SLICES.scope}: the diff spans exactly one file`,
      ).toHaveLength(1);
      expect(
        git.diff.split("\n").filter((line) => line.startsWith("@@")),
        `${SATCA_TC058_OWNING_SLICES.scope}: the diff is one contiguous hunk, so one case body changed`,
      ).toHaveLength(1);
    });

    await test.step("S002-O03: nothing has been committed", async () => {
      expect(
        git.headSha,
        `${SATCA_TC058_OWNING_SLICES.uncommitted}: HEAD is unmoved, so the retirement committed nothing`,
      ).toBe(baselineHeadSha);
      expect(
        git.staged,
        `${SATCA_TC058_OWNING_SLICES.uncommitted}: the change is left unstaged, for the reviewer to stage`,
      ).toEqual([]);
    });
  });

  // ── S003: reverse the retirement in the application ──────────────────────────
  await test.step("S003: reverse the retirement in the application", async () => {
    await panel.getByTestId(`archived-restore-${SATCA_TC058_RETIRE_CASE_ID}`).click();
    await expect(
      panel.getByTestId("case-row").filter({ hasText: SATCA_TC058_RETIRE_CASE_ID }),
      `${SATCA_TC058_OWNING_SLICES.restore}: ${SATCA_TC058_RETIRE_CASE_ID} returns to the live case list`,
    ).toBeVisible();
    await expect(
      panel.getByTestId("archived-cases"),
      `${SATCA_TC058_OWNING_SLICES.restore}: the archived section goes away with its last entry`,
    ).toHaveCount(0);
  });

  await test.step("S003-O01: the working tree returns to clean", async () => {
    // A real assertion, not a formality. It holds only if the restore reproduces
    // the committed file BYTE FOR BYTE: clearing the record is not enough if the
    // rewrite reflows the document or leaves the schemaVersion raised. A failure
    // here is a defect in the write path (#772), never something to loosen.
    const git = await inspectBenchGit(request, { projectId: PROJECT_ID, benchId });
    expect(
      git.modified,
      `${SATCA_TC058_OWNING_SLICES.restore}: the restore leaves no modified file, so the reversal is exact`,
    ).toEqual([]);
    expect(
      git.untracked,
      `${SATCA_TC058_OWNING_SLICES.restore}: the restore leaves no new file behind`,
    ).toEqual([]);
    expect(
      git.diff,
      `${SATCA_TC058_OWNING_SLICES.restore}: the worktree diff is empty after the reversal`,
    ).toBe("");
    expect(
      git.headSha,
      `${SATCA_TC058_OWNING_SLICES.uncommitted}: the reversal committed nothing either`,
    ).toBe(baselineHeadSha);
  });
});
