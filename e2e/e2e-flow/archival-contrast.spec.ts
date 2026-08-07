import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { injectAxe, scanBothThemes } from "./_support/axe-contrast.js";
import {
  loadAppShell,
  registerFixtureProject,
  resetWithScenario,
  showTestBenchCasesView,
} from "./_support/scenario.js";
import {
  SATCA_A11Y_LIVE_CASE_ID,
  SATCA_A11Y_MARK_FAIL_EXPECTATION,
  SATCA_A11Y_MARK_PASS_EXPECTATION,
  SATCA_A11Y_MARKED_CASE_ID,
  SATCA_A11Y_MARKED_REASON,
  SATCA_A11Y_PLAN,
  SATCA_A11Y_RETIRED_CASE_ID,
  SATCA_A11Y_SPEC_SLUG,
  SATCA_A11Y_SUPERSEDED_CASE_ID,
  SATCA_ARCHIVED_PLAN,
  SATCA_ARCHIVED_REASON,
  SATCA_ARCHIVED_SPEC_SLUG,
  SATCA_LIVE_SPEC_SLUG,
  SATCA_SUPERSEDED_PLAN,
  SATCA_SUPERSEDED_SPEC_SLUG,
} from "./_support/testbench-plan.js";

// E2E (#775, SATCA-NFR-005, SATCA-TC-019 S002-O02): the real-rendering WCAG AA
// color-contrast guard for the ARCHIVAL surfaces, the counterpart of the
// partitioned-picker guard in spec-picker-contrast.spec.ts (#493). jsdom has no
// layout/paint engine, so the vitest-axe suites beside these components report
// zero color-contrast violations even when text fails AA in a browser; the only
// way to decide the rule is to run it in Chromium against the BUILT app.
//
// spec-picker-contrast.spec.ts scans the live partitions (needs-attention plus
// the all-passed disclosure) and never reveals the archived group, so before
// this spec no archived state was contrast-checked anywhere. The surfaces here
// are exactly the ones #769/#770/#772/#774 added:
//
//   1. the spec picker with the archived group revealed (archived and superseded
//      row labels, the recorded reason, the superseding slug),
//   2. the TestBench panel's Archived cases section (state labels, situation
//      text, retained reasons and replacements, Restore),
//   3. the case detail pane's retire and supersede lifecycle disclosures, and
//      the replacement picker dialog they open.
//
// #797 closed the one gap #775 left: the pass/fail mark colours ObservationMarks
// renders on an archived entry (text-green-700 / text-red-700 in light,
// green-400 / red-400 in dark). No fixture seam can reach them, because the
// seeded-results synthesizer writes an empty `observationMarks` map and
// ObservationMarks renders nothing for one, so the panel test now drives the
// real journey instead: it marks two observations on a dedicated live case (one
// pass, one fail), retires that case from the detail pane, and scans the
// Archived section again with the retained marks on screen. The same step
// asserts #775's AC4 focus landing in a real browser, which the jsdom suite can
// only observe through a callback.
//
// Each is scanned in BOTH themes. The injection, theme-flip and scan helpers are
// the shared ones in _support/axe-contrast.ts; the scans are scoped to the
// archival surface under test rather than the whole page, so a pre-existing
// failure elsewhere in the pane cannot masquerade as an archival regression (and
// vice versa).

const SCENARIO = "default";
const NOW = "2026-07-10T09:00:00.000Z";

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

// Mark ONE observation of the open case detail pane, addressed by its `expected`
// text (the mark control's accessible name is
// `Mark observation pass or fail: ${expected}`), so a case carrying several
// observations can be marked per observation rather than as a whole. React
// Aria's ToggleButton hosts the press responder on the visible "Pass"/"Fail"
// label, so that text is the click target; awaiting the checked state is what
// proves the mark round-tripped to the sidecar before the case is retired.
async function markObservation(
  panel: Locator,
  expected: string,
  result: "pass" | "fail",
): Promise<void> {
  const group = panel.getByRole("radiogroup", {
    name: `Mark observation pass or fail: ${expected}`,
  });
  const label = result === "pass" ? "Pass" : "Fail";
  await group.getByText(label, { exact: true }).click();
  await expect(
    group.getByRole("radio", { name: label }),
    `observation "${expected}" marked ${result}`,
  ).toBeChecked();
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("#775: the spec picker's revealed archived group meets WCAG AA color-contrast in both themes", async ({
  page,
  request,
}) => {
  await enableTestBench(request);
  const projectId = "satca-contrast-picker-archived";
  await registerFixtureProject(request, {
    projectId,
    gitInit: true,
    seedSpecs: [
      { slug: SATCA_A11Y_SPEC_SLUG, testCases: SATCA_A11Y_PLAN },
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

  await loadAppShell(page);
  await gotoBenchList(page, projectId);
  await injectAxe(page);

  const dialog = page.getByRole("dialog", { name: "Create a TestBench" });

  await test.step("open the picker with archived specs present but hidden", async () => {
    await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
    await page.getByRole("button", { name: "Create a TestBench" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: /^Show archived/ })).toBeVisible();
  });

  await test.step("collapsed: the reveal control itself meets AA in both themes", async () => {
    await scanBothThemes(page, dialog, "picker/archived-hidden");
  });

  await test.step("revealed: the archived rows and their labels meet AA in both themes", async () => {
    await dialog.getByRole("button", { name: /^Show archived/ }).click();
    const archivedGroup = dialog.locator('[aria-label="Archived specs"]');
    await expect(archivedGroup.getByRole("radio").first()).toBeVisible();
    // The row labels and the recorded reason are the text this scan exists for.
    await expect(archivedGroup).toContainText("Archived");
    await expect(archivedGroup).toContainText("Superseded");
    await expect(archivedGroup).toContainText(SATCA_ARCHIVED_REASON);
    await scanBothThemes(page, dialog, "picker/archived-revealed");
  });
});

// A taller viewport than the 720px default: the review tab stacks the rollup,
// the case list, the detail pane and the Archived section in one column, and at
// 720px the Archived section overlaps the case rows, so a click on a row is
// intercepted before the pane can be opened. The extra height is a harness
// concern only; nothing about the contrast measurement depends on it.
test.describe(() => {
  test.use({ viewport: { width: 1440, height: 1200 } });

  test("#775: the panel's Archived cases section and the case-detail lifecycle disclosures meet WCAG AA in both themes", async ({
    page,
    request,
  }) => {
    await enableTestBench(request);
    const projectId = "satca-contrast-panel-archived";
    await registerFixtureProject(request, {
      projectId,
      gitInit: true,
      seedSpecs: [{ slug: SATCA_A11Y_SPEC_SLUG, testCases: SATCA_A11Y_PLAN }],
    });

    await loadAppShell(page);
    await gotoBenchList(page, projectId);

    const createDialog = page.getByRole("dialog", { name: "Create a TestBench" });
    await test.step("precondition: create a TestBench on the spec carrying archived cases", async () => {
      await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
      await page.getByRole("button", { name: "Create a TestBench" }).click();
      await expect(createDialog).toBeVisible();
      await createDialog
        .getByRole("radio", { name: new RegExp(`^${SATCA_A11Y_SPEC_SLUG}`) })
        .click();
      const createButton = createDialog.getByRole("button", { name: "Create TestBench" });
      await expect(createButton).toBeEnabled();
      await createButton.click();
      await expect(createDialog).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/benches/\\d+$`));
    });

    // axe is injected after the create navigation, which is a fresh document.
    await injectAxe(page);

    const panel = page.getByRole("tabpanel");
    const archivedSection = panel.getByTestId("archived-cases");

    await test.step("open the TestBench Cases review", async () => {
      await page
        .getByRole("tablist")
        .getByRole("tab", { name: /^TestBench/ })
        .click();
      await expect(panel).toBeVisible();
      await showTestBenchCasesView(page);
      await expect(archivedSection).toBeVisible();
    });

    await test.step("the Archived cases section meets AA in both themes", async () => {
      // The state labels, the situation lines, and the retained reason are the
      // text AC5 is about; assert they are on screen before measuring them.
      await expect(archivedSection).toContainText("Retired");
      await expect(archivedSection).toContainText("Superseded");
      await expect(
        archivedSection.getByTestId(`archived-case-${SATCA_A11Y_RETIRED_CASE_ID}`),
      ).toBeVisible();
      await expect(
        archivedSection.getByTestId(`archived-replacement-${SATCA_A11Y_SUPERSEDED_CASE_ID}`),
      ).toBeVisible();
      await expect(
        archivedSection.getByTestId(`archived-restore-${SATCA_A11Y_RETIRED_CASE_ID}`),
      ).toBeVisible();
      await scanBothThemes(page, archivedSection, "panel/archived-section");
    });

    await test.step("#797: mark two observations pass and fail on a live case", async () => {
      // The mark colours can only be reached through the real journey: the
      // seeded-results seam synthesizes an empty observationMarks map, and
      // ObservationMarks renders nothing for one.
      await panel.getByTestId("case-row").filter({ hasText: SATCA_A11Y_MARKED_CASE_ID }).click();
      await markObservation(panel, SATCA_A11Y_MARK_PASS_EXPECTATION, "pass");
      await markObservation(panel, SATCA_A11Y_MARK_FAIL_EXPECTATION, "fail");
    });

    const markedEntry = archivedSection.getByTestId(`archived-case-${SATCA_A11Y_MARKED_CASE_ID}`);

    await test.step("#797: retiring the marked case moves it, with its marks, into the Archived section", async () => {
      await panel.getByTestId("case-retire-open").click();
      await panel.getByTestId("case-retire-reason").fill(SATCA_A11Y_MARKED_REASON);
      await panel.getByTestId("case-retire-submit").click();
      await expect(markedEntry).toBeVisible();
      // #775 AC4: the applying control unmounts with the case, so focus is moved
      // to the archived entry the case arrived on. jsdom can only observe this
      // through the callback; here it is the real document.activeElement.
      await expect(markedEntry, "#775 AC4: focus lands on the archived entry").toBeFocused();
      await expect(markedEntry).toContainText(SATCA_A11Y_MARKED_REASON);
    });

    await test.step("#797: the retained pass/fail mark colours meet AA in both themes", async () => {
      // The positive control for the scan below: the green and the red token are
      // both on screen, so a passing scan measured them rather than nothing. The
      // mark text is lowercase, which keeps it distinct from the "Passed"/
      // "Failed" status label rendered on the same entry.
      await expect(markedEntry.getByText("pass", { exact: true })).toBeVisible();
      await expect(markedEntry.getByText("fail", { exact: true })).toBeVisible();
      await scanBothThemes(page, archivedSection, "panel/archived-section-with-marks");
    });

    await test.step("the retire disclosure meets AA in both themes", async () => {
      await panel.getByTestId("case-row").filter({ hasText: SATCA_A11Y_LIVE_CASE_ID }).click();
      const retireToggle = panel.getByTestId("case-retire-open");
      await expect(retireToggle).toBeVisible();
      await retireToggle.click();
      const retirePanel = panel.getByTestId("case-retire-panel");
      await expect(retirePanel).toBeVisible();
      await scanBothThemes(page, retirePanel, "case-detail/retire-disclosure");
    });

    await test.step("the supersede disclosure and its replacement picker meet AA in both themes", async () => {
      await panel.getByTestId("case-supersede-open").click();
      const supersedePanel = panel.getByTestId("case-supersede-panel");
      await expect(supersedePanel).toBeVisible();
      await scanBothThemes(page, supersedePanel, "case-detail/supersede-disclosure");

      await panel.getByTestId("case-supersede-choose").click();
      const picker = page.getByRole("dialog", {
        name: new RegExp(`^Supersede ${SATCA_A11Y_LIVE_CASE_ID}`),
      });
      await expect(picker).toBeVisible();
      await expect(picker.getByTestId("replacement-filter")).toBeVisible();
      await scanBothThemes(page, picker, "replacement-picker/no-selection");

      // With a candidate active: the highlighted row and the resolution preview
      // are separate colour states, so both are measured.
      const option = picker.getByRole("option").first();
      await expect(option).toBeVisible();
      await option.click();
      await expect(picker.getByTestId("replacement-preview")).toBeVisible();
      await scanBothThemes(page, picker, "replacement-picker/with-selection");
    });
  });
});
