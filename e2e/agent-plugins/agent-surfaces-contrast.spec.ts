import { expect, test, type Page } from "@playwright/test";
import { injectAxe, scanBothThemes } from "../e2e-flow/_support/axe-contrast.js";
import {
  CLAUDE_PLUGIN_ID,
  CODEX_PLUGIN_ID,
  consentAgent,
  disablePlugin,
  enablePlugin,
  setDefaultAgent,
  waitForAvailableAgents,
} from "./_support/agent-env.js";

// E2E (#703): the real-rendering WCAG AA color-contrast guard for the two agent
// surfaces, closing the half of AP-TC-050 S003-O01 and AP-TC-127 S003-O01 that
// the jsdom vitest-axe suites (#524) cannot decide. jsdom computes no layout, so
// axe-core's `color-contrast` rule never executes there: it silently reports zero
// contrast violations even when text fails AA in a browser. This spec injects the
// bundled axe-core into Chromium against the BUILT app and runs ONLY the
// color-contrast rule over the rendered surfaces, in BOTH themes (the app toggles
// a `.dark` class on <html>, see client/src/hooks/useSettings.ts):
//
//   - Settings, AI Agents: the installed-plugin list with both cards'
//     schema-driven config forms expanded (AP-TC-127 S003-O01).
//   - Settings, Jigs: the default-agent picker radiogroup, at rest and with a
//     tile keyboard-focused (AP-TC-050 S003-O01).
//
// The technique is the one #493 established for the spec picker; the helpers are
// shared from e2e-flow/_support/axe-contrast.ts rather than copied.
//
// WHAT THIS DOES NOT COVER. axe's `color-contrast` rule measures TEXT against its
// background. The focused tile's ring is a `ring`/`box-shadow`, i.e. WCAG 1.4.11
// non-text contrast, which axe does not implement under this rule. The focused
// scan below proves the tile's text still clears AA while the ring paints; it is
// not evidence about the ring itself.
//
// HOW THE TWO-AGENT PRECONDITION IS MET. Both cases name Claude Code and Codex
// CLI, and with a single available agent the Jigs picker force-selects it
// (AP-TC-041) and the AI Agents screen renders one card, so neither surface would
// be the one the case describes. The second agent is the `codex-cli` bundled
// overlay at e2e/fixtures/bundled-overlays/codex-cli/, added by AP-TC-113 (#683)
// and reused here exactly as default-agent-tiles.spec.ts (#681) reuses it.
//
// The overlay is force-DISABLED by every /test/__reset (see
// OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in server/routes/test.ts). Consent has no
// revoke route and outlives the server process, so a second consented agent left
// enabled would leak into every later spec and un-resolve the default that
// AP-TC-087's single-available-agent fallback depends on (NFR-018). This spec
// opts in, and hands the environment back the way it found it.

const SETTINGS_PATH = "/settings";

/** Open Settings on the tab the given hash deep-links to (see HASH_TAB_IDS). */
async function openSettingsTab(page: Page, hash: string): Promise<void> {
  const res = await page.goto(`${SETTINGS_PATH}#${hash}`);
  expect(res?.status(), `GET ${SETTINGS_PATH}#${hash}`).toBe(200);
}

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);

  await enablePlugin(request, CODEX_PLUGIN_ID);
  await consentAgent(request, CLAUDE_PLUGIN_ID);
  await consentAgent(request, CODEX_PLUGIN_ID);
  await waitForAvailableAgents(request, [CLAUDE_PLUGIN_ID, CODEX_PLUGIN_ID]);

  // Pinned rather than inferred: with two available agents the "exactly one
  // agent, so it is the default" fallback no longer applies, so without this the
  // Jigs picker would render with no tile selected and the selected-tile colours
  // (the ones the highlight and the check indicator use) would never be scanned.
  await setDefaultAgent(request, CLAUDE_PLUGIN_ID);
});

test.afterEach(async ({ request }) => {
  await setDefaultAgent(request, null);
  await disablePlugin(request, CODEX_PLUGIN_ID);
});

test("AP-TC-127 S003: the AI Agents screen meets WCAG AA color-contrast in both themes", async ({
  page,
}) => {
  await openSettingsTab(page, "ai-agents");

  const installed = page.locator('section[aria-label="Installed agent plugins"]');
  await expect(installed, "the installed-agents section renders").toBeVisible();

  const claudeCard = page.getByTestId(`agent-plugin-card-${CLAUDE_PLUGIN_ID}`);
  const codexCard = page.getByTestId(`agent-plugin-card-${CODEX_PLUGIN_ID}`);
  await expect(claudeCard, "the Claude Code card renders").toBeVisible();
  await expect(codexCard, "the Codex CLI card renders").toBeVisible();

  // The case's S003 says "with the Claude Code and Codex configuration forms
  // rendered". AgentPluginCard mounts its disclosure open (useState(true)), so
  // both forms are already expanded; this asserts it rather than assuming it, so
  // a future default flip turns into a failed precondition rather than a scan
  // that quietly measures nothing.
  await expect(
    claudeCard.getByTestId(`agent-config-form-${CLAUDE_PLUGIN_ID}`),
    "the Claude Code config form is expanded",
  ).toBeVisible();
  await expect(
    claudeCard.locator('[data-testid^="config-field-"]').first(),
    "the Claude Code schema-driven controls render",
  ).toBeVisible();
  await expect(
    codexCard.getByTestId(`agent-config-form-${CODEX_PLUGIN_ID}`),
    "the Codex CLI config form is expanded",
  ).toBeVisible();

  await injectAxe(page);

  await test.step("installed list and expanded forms: zero color-contrast violations in both themes", async () => {
    await scanBothThemes(page, installed, "ai-agents/installed+forms");
  });
});

test("AP-TC-050 S003: the Jigs default-agent picker meets WCAG AA color-contrast in both themes", async ({
  page,
}) => {
  await openSettingsTab(page, "jigs");

  const group = page.getByRole("radiogroup", { name: "Default agent" });
  const claudeTile = page.getByTestId(`default-agent-tile-${CLAUDE_PLUGIN_ID}`);
  const codexTile = page.getByTestId(`default-agent-tile-${CODEX_PLUGIN_ID}`);

  await expect(group, "the Default agent radiogroup renders").toBeVisible();
  await expect(claudeTile, "the Claude Code tile renders").toBeVisible();
  await expect(codexTile, "the Codex CLI tile renders").toBeVisible();
  // One tile selected and one not, so a single scan covers both the selected and
  // the unselected tile colours.
  await expect(claudeTile, "Claude Code is the pinned default").toHaveAttribute(
    "data-selected",
    "true",
  );
  await expect(codexTile, "Codex CLI is unselected").toHaveAttribute("data-selected", "false");

  await injectAxe(page);

  await test.step("resting state: zero color-contrast violations in both themes", async () => {
    await scanBothThemes(page, group, "jigs/default-agent/resting");
  });

  await test.step("focused tile: zero color-contrast violations in both themes", async () => {
    // Keyboard modality is what makes React Aria's `isFocusVisible` true, so the
    // ring only paints after a real Tab; a programmatic .focus() sets the
    // modality to `virtual` instead and would leave the tile in its resting
    // styling, making this step a second scan of the state above. Tab forward
    // from the top of the document until the tile's own `ring-2` appears, which
    // is the rendered ring rather than a proxy for it (the radio input React
    // Aria focuses is a visually-hidden SIBLING of this div, so `:focus-within`
    // on the tile would never match).
    const ringVisible = async () =>
      ((await claudeTile.getAttribute("class")) ?? "").includes("ring-2");
    for (let i = 0; i < 60 && !(await ringVisible()); i += 1) {
      await page.keyboard.press("Tab");
    }
    await expect(claudeTile, "the focused tile carries the focus ring").toHaveClass(/ring-2/);
    await scanBothThemes(page, group, "jigs/default-agent/focused");
  });
});
