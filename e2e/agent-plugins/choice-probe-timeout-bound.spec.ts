import { expect, test, type APIRequestContext } from "@playwright/test";
import { CHOICE_PROBE_TIMEOUT_MS, type PluginRecord } from "@roubo/shared";
import { consentAgent, disablePlugin, enablePlugin } from "./_support/agent-env.js";
import { clearProbeMode, setProbeMode } from "./_support/probe-mode.js";

// E2E: APCC-TC-019 S001, measured the way the case reads it, in a real browser
// against the BUILT app. With the model-listing command unresponsive, the
// probed field must report its failure within 5 s of rendering (APCC-NFR-002).
//
// The host kills a choice probe at CHOICE_PROBE_TIMEOUT_MS, and the field learns
// of the kill only on its next read of the list, one PROBE_POLL_INTERVAL_MS
// later at most. When the kill sat exactly on the 5 s bound, this spec measured
// the failure at about 5002 ms after render on 6 of 7 runs.
//
// HOW THE PROBE HANGS. The `agent-choice-probe` bundled overlay points its
// `probedModel` choice probe at `roubo-e2e-probe-stub`, whose `hang` mode prints
// nothing and never exits, so only the host's kill ends the run.
//
// WHY THE PAGE MUST START THE PROBE. Every read of the agent inventory warms the
// probe, so waiting for the agent on that route (`waitForAvailableAgents`)
// would spawn the stub before the page exists and hand the field a head start.
// This spec waits on the plugin list instead, which spawns nothing, so the
// page's own first read is the warm that starts the probe, as it is for a user.

const PLUGIN_ID = "agent-choice-probe";
const FIELD = "probedModel";
const SETTINGS_PATH = "/settings#ai-agents";

/** APCC-NFR-002: the probe resolves or reports a failure within 5 s. */
const FIELD_BOUND_MS = 5_000;

/**
 * Longer than any host probe kill, so a probe the last read started has been
 * killed and has written its outcome before the next test's reset.
 */
const PROBE_DRAIN_MS = 6_000;

/** Block until the overlay's plugin process is running, without warming its probe. */
async function waitForPluginRunning(request: APIRequestContext): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/plugins");
        if (res.status() !== 200) return `GET /api/plugins answered ${res.status()}`;
        const body = (await res.json()) as { plugins: PluginRecord[] };
        const record = body.plugins.find((plugin) => plugin.id === PLUGIN_ID);
        return record === undefined ? "not installed" : `${record.status}/${record.pid !== null}`;
      },
      { message: `the ${PLUGIN_ID} plugin process is running`, timeout: 15_000 },
    )
    .toBe("enabled/true");
}

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/test/__reset", { data: {} });
  expect(reset.status(), "POST /test/__reset").toBe(200);
});

test.afterEach(async ({ page, request }) => {
  // Stop the screen's reads, and disable the agent so no later read warms it,
  // then let any probe already running reach its kill. Otherwise it would write
  // its failure into the outcome map after the next test's reset had cleared it.
  await page.close();
  await disablePlugin(request, PLUGIN_ID);
  await new Promise((resolve) => setTimeout(resolve, PROBE_DRAIN_MS));
  clearProbeMode();
});

test(
  "APCC-TC-019 S001: with the model-listing command unresponsive, the field reports a failure within 5 s of rendering",
  { tag: "@APCC-TC-019" },
  async ({ page, request }) => {
    setProbeMode("hang");
    await enablePlugin(request, PLUGIN_ID);
    await consentAgent(request, PLUGIN_ID);
    await waitForPluginRunning(request);

    // Stamp each state the field enters on the page's own clock, from the DOM
    // itself, so the measurement carries no Playwright polling delay.
    await page.addInitScript((testId: string) => {
      const marks: Record<string, number> = {};
      (window as unknown as { __probeMarks: Record<string, number> }).__probeMarks = marks;
      const stamp = () => {
        const field = document.querySelector(`[data-testid="${testId}"]`);
        if (field === null) return;
        const state = field.getAttribute("data-probe-state") ?? "resolved";
        marks[state] ??= performance.now();
      };
      new MutationObserver(stamp).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-probe-state"],
      });
    }, `config-field-${FIELD}`);

    const res = await page.goto(SETTINGS_PATH);
    expect(res?.status(), `GET ${SETTINGS_PATH}`).toBe(200);
    const field = page
      .getByTestId(`agent-plugin-card-${PLUGIN_ID}`)
      .getByTestId(`config-field-${FIELD}`);

    await expect(field, "the probed field has failed").toHaveAttribute(
      "data-probe-state",
      "failed",
      { timeout: 15_000 },
    );
    const marks = await page.evaluate(
      () => (window as unknown as { __probeMarks: Record<string, number> }).__probeMarks,
    );

    expect(marks.loading, "the field rendered in its loading state first").toBeDefined();
    expect(marks.resolved, "the field never resolved").toBeUndefined();
    const elapsed = marks.failed - marks.loading;
    test.info().annotations.push({ type: "loading-to-failed-ms", description: elapsed.toFixed(1) });
    expect(
      elapsed,
      `the field reported its failure ${Math.round(elapsed)} ms after rendering, and was no longer loading at the ${FIELD_BOUND_MS} ms mark`,
    ).toBeLessThanOrEqual(FIELD_BOUND_MS);

    await expect(
      field.getByRole("status"),
      "the field names the timeout, in the seconds the host actually waits",
    ).toContainText(
      `Could not read the choices: the CLI did not answer within ${CHOICE_PROBE_TIMEOUT_MS / 1000} seconds.`,
    );
  },
);
