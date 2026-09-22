import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { auditPageBothThemes, injectAxe } from "../e2e-flow/_support/axe-contrast.js";
import {
  consentAgent,
  disablePlugin,
  enablePlugin,
  waitForAvailableAgents,
} from "./_support/agent-env.js";
import { clearProbeMode, setProbeMode, type ProbeMode } from "./_support/probe-mode.js";

// E2E (#1306): the real-browser accessibility audit of the AI Agents screen in
// every choice-probe state, APCC-TC-022. The jsdom suite
// (client/src/components/ConfigSchemaForm.a11y.test.tsx) runs axe too, but jsdom
// computes no colour, so it stayed green while the live screen failed WCAG AA
// twice: the Select placeholder in dark (#1276, fixed by #1276) and the active
// sidebar item in light (fixed by #1304). This spec injects the bundled axe-core
// into Chromium against the BUILT app and runs the FULL ruleset over the whole
// page, failing on any serious or critical violation, in both themes.
//
// The whole page, not the card: the #1304 regression sat in the sidebar.
//
// HOW EACH PROBE STATE IS PRODUCED. The #1276 manual recipe restarted the server
// between states to empty the probe cache. One shared server serves this whole
// run, so instead:
//
//   - the `agent-choice-probe` bundled overlay declares a `dash-line-pairs`
//     choice probe for its `probedModel` field, pointed at
//     `roubo-e2e-probe-stub` (e2e/fixtures/bin/, on the server's PATH);
//   - the stub reads a mode file on every run (`setProbeMode`): `resolved`
//     answers at once, `slow` answers after 4.5 s (under the host's 5 s kill),
//     `fail` exits non-zero;
//   - `/test/__reset` empties the host's probe cache, so each test's first warm
//     spawns the stub again and reads the mode that test has just written.
//
// The overlay is force-DISABLED by every /test/__reset (see
// OPT_IN_AGENT_FIXTURE_PLUGIN_IDS in server/routes/test.ts): consent outlives
// the reset, so a second available agent left enabled would un-resolve the
// default AP-TC-087's single-available-agent fallback depends on (NFR-018). This
// spec opts in, and hands the environment back the way it found it.

const PLUGIN_ID = "agent-choice-probe";
const FIELD = "probedModel";
const SETTINGS_PATH = "/settings#ai-agents";

/** The upper bound on one slow probe run, with room for the spawn itself. */
const PROBE_SETTLE_TIMEOUT_MS = 10_000;

type ProbeState = "loading" | "resolved" | "failed";

/**
 * The probed field's state as the real agent inventory route reports it, or
 * `undefined` while the agent is unavailable: the host never warms an
 * unavailable agent's probes, so its field reads `loading` on every read and
 * that `loading` says nothing about a probe.
 */
async function readProbeState(request: APIRequestContext): Promise<ProbeState | undefined> {
  const res = await request.get("/api/agents");
  expect(res.status(), "GET /api/agents").toBe(200);
  const body = (await res.json()) as {
    agents: {
      id: string;
      unavailable: unknown;
      choiceProbes?: Record<string, { state: ProbeState }>;
    }[];
  };
  const agent = body.agents.find((a) => a.id === PLUGIN_ID);
  if (!agent || agent.unavailable !== null) return undefined;
  return agent.choiceProbes?.[FIELD]?.state;
}

/**
 * Poll the inventory route until the probed field reports `state`. Every read
 * also warms the probe, which is what spawns the stub in the first place.
 */
async function waitForProbeState(request: APIRequestContext, state: ProbeState): Promise<void> {
  await expect
    .poll(() => readProbeState(request), {
      message: `the ${FIELD} choice probe reports ${state}`,
      timeout: PROBE_SETTLE_TIMEOUT_MS,
    })
    .toBe(state);
}

/** Opt the overlay in and wait until the host resolves it, which starts the probe. */
async function enableProbeAgent(request: APIRequestContext, mode: ProbeMode): Promise<void> {
  setProbeMode(mode);
  await enablePlugin(request, PLUGIN_ID);
  await consentAgent(request, PLUGIN_ID);
  await waitForAvailableAgents(request, [PLUGIN_ID]);
}

async function openAiAgents(page: Page) {
  const res = await page.goto(SETTINGS_PATH);
  expect(res?.status(), `GET ${SETTINGS_PATH}`).toBe(200);
  const card = page.getByTestId(`agent-plugin-card-${PLUGIN_ID}`);
  await expect(card, "the choice-probe agent card renders").toBeVisible();
  return card;
}

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);
});

test.afterEach(async ({ request }) => {
  // A slow run still in flight would write its outcome into the probe cache
  // AFTER the next reset cleared it, and hand the next test this test's state.
  // Waiting for the field to leave `loading` first closes that window.
  await expect
    .poll(() => readProbeState(request), { timeout: PROBE_SETTLE_TIMEOUT_MS })
    .not.toBe("loading");
  await disablePlugin(request, PLUGIN_ID);
  clearProbeMode();
});

test(
  "APCC-TC-022 S001: the AI Agents screen has no serious or critical axe violation with the probed field resolved, in both themes",
  { tag: "@APCC-TC-022" },
  async ({ page, request }) => {
    await enableProbeAgent(request, "resolved");
    await waitForProbeState(request, "resolved");

    const card = await openAiAgents(page);
    const field = card.getByTestId(`config-field-${FIELD}`);
    await expect(field, "the probed field renders as a choice list").toBeVisible();
    await expect(field, "the probed field is not pending").not.toHaveAttribute("data-probe-state");

    // The choices the stub printed, proved by opening the list rather than by
    // trusting the route, then closed again so the audit sees the resting page.
    await field.locator("button").click();
    await expect(
      page.getByRole("option", { name: "Stub Balanced" }),
      "the probed choices render",
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("listbox"), "the choice list is closed again").toHaveCount(0);

    await injectAxe(page);
    await auditPageBothThemes(page, "ai-agents/probe-resolved");
  },
);

test(
  "APCC-TC-022 S002: the AI Agents screen has no serious or critical axe violation with the probed field loading, in both themes",
  { tag: "@APCC-TC-022" },
  async ({ page, request }) => {
    // Freeze the screen on the first read it makes. The slow probe answers 4.5 s
    // after its warm, and the screen polls every second while a field loads, so
    // without this the field could resolve mid-audit and the second theme would
    // be scanned in a different state from the first. The first reply is the real
    // server's, and every later poll is answered with that same reply.
    let firstReply: { status: number; body: string; contentType: string } | undefined;
    await page.route("**/api/agents", async (route) => {
      if (firstReply === undefined) {
        const response = await route.fetch();
        firstReply = {
          status: response.status(),
          body: await response.text(),
          contentType: response.headers()["content-type"] ?? "application/json",
        };
      }
      await route.fulfill(firstReply);
    });

    await enableProbeAgent(request, "slow");
    await waitForProbeState(request, "loading");

    const card = await openAiAgents(page);
    const field = card.getByTestId(`config-field-${FIELD}`);
    await expect(field, "the probed field is loading").toHaveAttribute(
      "data-probe-state",
      "loading",
    );
    await expect(
      field.getByRole("status"),
      "the loading status region announces the read",
    ).toHaveText("Reading the available choices from the CLI.");

    await injectAxe(page);
    await auditPageBothThemes(page, "ai-agents/probe-loading");

    await expect(field, "the field was still loading after the audit").toHaveAttribute(
      "data-probe-state",
      "loading",
    );
  },
);

test(
  "APCC-TC-022 S003: the AI Agents screen has no serious or critical axe violation with the probed field failed, in both themes",
  { tag: "@APCC-TC-022" },
  async ({ page, request }) => {
    await enableProbeAgent(request, "fail");
    await waitForProbeState(request, "failed");

    const card = await openAiAgents(page);
    const field = card.getByTestId(`config-field-${FIELD}`);
    await expect(field, "the probed field has failed").toHaveAttribute(
      "data-probe-state",
      "failed",
    );
    await expect(
      field.getByRole("status"),
      "the status region quotes the CLI's failure",
    ).toContainText("Could not read the choices: not signed in");

    await injectAxe(page);
    await auditPageBothThemes(page, "ai-agents/probe-failed");
  },
);
