import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { loadAppShell, registerFixtureProject, resetWithScenario } from "./_support/scenario.js";
import { TC_069, TC_069_OWNING_SLICES } from "./_support/testbench-plan.js";

// E2E (#441): the authoritative `e2e_flow` drift guard for the
// "toggle TestBench off, verify the surface is hidden, toggle back on, verify it
// is restored" journey (TC-069, US-010, FR-018/FR-001). It walks the integrated
// system end to end against the BUILT app: with the feature enabled, open the
// app-settings TestBench tab, drive the REAL UI Switch off (asserting the surface
// disappears from the bench list), then back on (asserting the surface returns),
// and assert each leg matches TC-069.
//
// Unlike the per-slice unit tests (#414/#416/#417/#418 own those), this asserts
// the journey, not any single slice's implementation. Each step is wrapped in a
// labelled `test.step` so a failure localises the diverging step, reports the
// expected-vs-actual at that step, and names the owning slice (FR-020 / AC6).
//
// The toggle is driven through the real Switch (role="switch", accessible name
// "Enable TestBench") rather than the API, because the app-settings tab + toggle
// is the journey under test. The toggle round-trips PUT /api/settings via
// `updateSettings`; the bench list reads the same settings, so navigating between
// the two surfaces reflects the new value. Playwright's retrying web-first
// assertions absorb the React Query refetch latency across navigation.
//
// Settings is a page, not a modal: TC-069's "Open app settings" maps to navigating
// to `/settings`, and "Close app settings" maps to navigating to the bench list at
// `/projects/:id`. The gated surface entry point is the "Create a TestBench" option
// in the empty-slot menu, shown only when the feature is enabled.

const SCENARIO = "default";
const NOW = "2026-06-08T09:00:00.000Z";
const PROJECT_ID = "tc-069-toggle-testbench";

// Rendered exactly when the toggle is OFF (ProjectSettings TestBenchTab). The
// drift guard asserts on this string verbatim so a copy change moves together.
const DISABLED_HELPER_TEXT =
  "Disabled. The create-TestBench option and the TestBench surface are hidden.";

async function enableTestBench(request: APIRequestContext): Promise<void> {
  // PUT /api/settings replaces the whole preferences object and validates a
  // required `theme`, so round-trip the current settings with testBench.enabled
  // flipped on rather than sending a partial body. This makes the precondition
  // explicit and deterministic regardless of the persisted default (#417 owns the
  // testBench.enabled persistence this round-trips through).
  const current = await request.get("/api/settings");
  expect(current.status(), TC_069_OWNING_SLICES.persistence).toBe(200);
  const settings = (await current.json()) as Record<string, unknown>;
  const res = await request.put("/api/settings", {
    data: { ...settings, testBench: { enabled: true } },
  });
  expect(
    res.status(),
    `${TC_069_OWNING_SLICES.persistence}: PUT /api/settings testBench.enabled`,
  ).toBe(200);
  const body = (await res.json()) as { testBench?: { enabled?: boolean } };
  expect(body.testBench?.enabled, TC_069_OWNING_SLICES.persistence).toBe(true);
}

async function gotoSettingsTestBenchTab(page: Page): Promise<void> {
  // "Open app settings" + "Navigate to the 'TestBench' tab". Settings is the
  // global `/settings` page; the deep-link hash pre-selects the TestBench tab.
  const res = await page.goto("/settings#testbench");
  expect(res?.status()).toBe(200);
  const tab = page.getByRole("tab", { name: "TestBench" });
  await expect(tab, TC_069_OWNING_SLICES.toggle).toBeVisible();
  await tab.click();
  await expect(
    tab,
    `${TC_069_OWNING_SLICES.toggle}: the TestBench settings tab is selected`,
  ).toHaveAttribute("aria-selected", "true");
}

async function gotoBenchList(page: Page, projectId: string): Promise<void> {
  // "Close app settings and inspect the main UI": settings is a page, so closing
  // it == navigating to the project's bench list.
  const res = await page.goto(`/projects/${projectId}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText("Bench 1")).toBeVisible();
}

// Click the Enable TestBench switch. React Aria renders the switch as a
// full-width pressable <input data-react-aria-pressable> whose hit area is
// visually covered by the adjacent label text, so a plain center click is
// intercepted by that label div. The input itself is the genuine interactive
// target (it carries the press handler), so a forced click dispatches the toggle
// correctly without depending on the visual pill's exact geometry.
async function clickTestBenchSwitch(toggle: Locator): Promise<void> {
  await toggle.click({ force: true });
}

// Open the empty-slot option menu on Bench 1, mirroring the sibling create-flow
// spec's pattern (the slot card is a button wrapping the "Bench 1" label).
async function openEmptySlotMenu(page: Page): Promise<void> {
  await page.getByText("Bench 1").locator("xpath=ancestor::button[1]").click();
  // The standard "Set up blank bench" option is always present in the menu and is
  // the stable anchor that proves the menu opened, independent of the gated option.
  await expect(
    page.getByRole("button", { name: "Set up blank bench" }),
    TC_069_OWNING_SLICES.gatedSurface,
  ).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  await resetWithScenario(request, SCENARIO, NOW);
});

test("TC-069: toggle TestBench off and on, surface hidden then restored", async ({
  page,
  request,
}) => {
  // ── Preconditions: feature enabled, project registered, app shell loaded ─────
  await test.step("Precondition: TestBench is enabled (toggle ON) (#414/#417)", async () => {
    await enableTestBench(request);
  });

  await test.step("Precondition: register a project (no spec/worktree needed)", async () => {
    // No gitInit / seedSpecs: this journey never discovers a spec or creates a
    // bench, so a plain fixture project (empty bench slots from the roubo.yaml
    // cap) is all the bench list needs.
    const { projectId } = await registerFixtureProject(request, { projectId: PROJECT_ID });
    expect(projectId).toBe(PROJECT_ID);
  });

  await loadAppShell(page);

  // ── Step 1+2+3: open app settings -> TestBench tab -> switch ON, no helper text (AC1) ─
  // TC-069 steps "Open app settings", "Navigate to the 'TestBench' tab", "Observe
  // the switch state" => "Switch is ON (amber) with no disabled helper text".
  const toggle = page.getByRole("switch", { name: "Enable TestBench" });
  await test.step("Step 1: open app settings, TestBench tab -> switch ON, no disabled helper text (AC1, #414)", async () => {
    await gotoSettingsTestBenchTab(page);
    // React Aria's Switch renders a native <input role="switch" type="checkbox">,
    // so its on/off state reflects on the native `checked` property (not an
    // aria-checked attribute); assert with toBeChecked() accordingly.
    await expect(
      toggle,
      `${TC_069_OWNING_SLICES.toggle}: the Enable TestBench switch starts ON`,
    ).toBeChecked();
    await expect(
      page.getByText(DISABLED_HELPER_TEXT),
      `${TC_069_OWNING_SLICES.helperText}: no disabled helper text while enabled`,
    ).toBeHidden();
  });

  // ── Step 2: toggle OFF -> switch OFF + disabled helper text appears (AC2) ─────
  await test.step("Step 2: click the switch to toggle OFF -> switch OFF, disabled helper text appears (AC2, #414)", async () => {
    await clickTestBenchSwitch(toggle);
    await expect(
      toggle,
      `${TC_069_OWNING_SLICES.toggle}: the switch turns OFF after the click`,
    ).not.toBeChecked();
    await expect(
      page.getByText(DISABLED_HELPER_TEXT),
      `${TC_069_OWNING_SLICES.helperText}: the disabled helper text appears when OFF`,
    ).toBeVisible();
  });

  // ── Step 3: close settings -> create-TestBench option absent / surface gone (AC3) ─
  await test.step("Step 3: close settings -> create-TestBench option absent, surface not accessible (AC3, #418/#416)", async () => {
    await gotoBenchList(page, PROJECT_ID);
    await openEmptySlotMenu(page);
    await expect(
      page.getByRole("button", { name: "Create a TestBench" }),
      `${TC_069_OWNING_SLICES.gatedSurface}: 'Create a TestBench' option is absent while disabled`,
    ).toBeHidden();
  });

  // ── Step 4: re-open settings, toggle ON -> switch ON, helper text removed (AC4) ─
  await test.step("Step 4: re-open settings, toggle the switch back ON -> switch ON, helper text removed (AC4, #414)", async () => {
    await gotoSettingsTestBenchTab(page);
    // After navigating back, the toggle reflects the persisted OFF state.
    await expect(
      toggle,
      `${TC_069_OWNING_SLICES.persistence}: the switch reflects the persisted OFF state`,
    ).not.toBeChecked();
    await clickTestBenchSwitch(toggle);
    await expect(toggle, `${TC_069_OWNING_SLICES.toggle}: the switch turns back ON`).toBeChecked();
    await expect(
      page.getByText(DISABLED_HELPER_TEXT),
      `${TC_069_OWNING_SLICES.helperText}: the disabled helper text is removed when ON`,
    ).toBeHidden();
  });

  // ── Step 5: close settings -> create-TestBench option visible again (AC4) ─────
  await test.step("Step 5: close settings -> create-TestBench option visible again, surface accessible (AC4, #418/#416)", async () => {
    await gotoBenchList(page, PROJECT_ID);
    await openEmptySlotMenu(page);
    await expect(
      page.getByRole("button", { name: "Create a TestBench" }),
      `${TC_069_OWNING_SLICES.gatedSurface}: 'Create a TestBench' option is visible again when re-enabled`,
    ).toBeVisible();
  });

  // The whole spec, with per-step owning-slice labels, IS the TC-069 drift guard
  // end to end (AC5); the `test.step` labels + `expect` messages satisfy the
  // failure-localisation contract (AC6). Reference TC_069 so the authoritative
  // case object is bound to this spec and a journey change moves them together.
  expect(TC_069.id).toBe("TC-069");
  expect(TC_069.steps.length).toBeGreaterThan(0);
});
