// @vitest-environment jsdom
/**
 * AP-TC-049 S003 / AP-NFR-002: the per-launch override dialog and the Terminal
 * launch menu each open in at most 200ms.
 *
 * Same shape as the server-side AP-TC-048 harness: the wall-clock budget is gated
 * behind RUN_PERF_HARNESS=1 (jsdom render timings on a loaded CI box are too
 * noisy to gate a merge on), with a sentinel keeping the file contributing a
 * passing assertion under the default run.
 *
 * The non-gated structural test pins the architectural property the budget rests
 * on: opening the dialog performs no I/O at all. Every layer it needs is already
 * in the props (a `ProjectAgentState` carries `appDefaults` and `overrides`
 * separately, a `ResolvedAgentPreset` carries `params`), so the trace is derived
 * locally. A future change that fetched the resolved config on open would regress
 * AP-NFR-002 rather than merely slowing a test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { Button, MenuTrigger } from "react-aria-components";
import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import { renderWithProviders } from "../test/renderWithProviders";
import LaunchOverridesDialog from "./LaunchOverridesDialog";
import AgentLaunchMenu from "./AgentLaunchMenu";
import { resolveLaunchTarget } from "./settings/agents/agent-launchability";

const RUN = process.env.RUN_PERF_HARNESS === "1";
const OPEN_BUDGET_MS = 200;
const ITERATIONS = 20;

const CLAUDE: ProjectAgentState = {
  id: "claude-code",
  name: "Claude Code",
  configSchema: {
    properties: {
      model: { enum: ["opus", "sonnet", "haiku"] },
      effort: { enum: ["high", "xhigh", "max"] },
      mode: { enum: ["plan", "auto"] },
    },
  },
  appDefaults: { model: "opus", effort: "high", mode: "plan" },
  overrides: { model: "sonnet" },
  effective: { model: "sonnet", effort: "high", mode: "plan" },
  unavailable: null,
  misconfigured: null,
};

const PRESET: ResolvedAgentPreset = {
  id: "__builtin_agent__",
  name: "Agent",
  icon: "bot",
  source: "builtin",
  agent: "default",
  bindsDefaultAgent: true,
  agentPluginId: "claude-code",
  resolvedAgentName: "Claude Code",
  params: {},
};

function openDialog() {
  return render(
    <LaunchOverridesDialog
      isOpen
      agents={[CLAUDE]}
      presets={[PRESET]}
      resolveTarget={(preset) => resolveLaunchTarget(preset, [CLAUDE], undefined)}
      initialPresetId={PRESET.id}
      onCancel={vi.fn()}
      onLaunch={vi.fn()}
    />,
  );
}

/** Time one open-to-interactive: mounted, and the primary control queryable. */
function timeDialogOpen(): number {
  const started = performance.now();
  const { unmount } = openDialog();
  // Interactive means the fields are there to be driven, so the query is part of
  // the measurement rather than an afterthought.
  screen.getByLabelText("Agent");
  screen.getByRole("button", { name: /Launch session/ });
  const elapsed = performance.now() - started;
  unmount();
  return elapsed;
}

function timeMenuOpen(): number {
  const { unmount } = renderWithProviders(
    <MenuTrigger>
      <Button aria-label="Choose launch option" />
      <AgentLaunchMenu
        presets={[PRESET]}
        agents={[CLAUDE]}
        resolveTarget={(preset) => resolveLaunchTarget(preset, [CLAUDE], undefined)}
        onLaunchPreset={vi.fn()}
        onLaunchAgent={vi.fn()}
        onLaunchWithOverrides={vi.fn()}
      />
    </MenuTrigger>,
  );
  const started = performance.now();
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Choose launch option" }));
  });
  screen.getByRole("menu");
  const elapsed = performance.now() - started;
  unmount();
  return elapsed;
}

function report(label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const worst = sorted[sorted.length - 1] ?? 0;
  console.log(
    JSON.stringify(
      {
        kind: "perf-evidence",
        tc: "AP-TC-049",
        surface: label,
        iterations: samples.length,
        medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
        worstMs: worst,
        budgetMs: OPEN_BUDGET_MS,
      },
      null,
      2,
    ),
  );
  return worst;
}

it.runIf(RUN)(
  "AP-TC-049 S003: the override dialog and the launch menu both open within 200ms",
  () => {
    // Warmup so first-render module cost does not land in the sample.
    timeDialogOpen();
    timeMenuOpen();

    const dialog: number[] = [];
    const menu: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      dialog.push(timeDialogOpen());
      menu.push(timeMenuOpen());
    }

    // AP-TC-049 S003-O01 is a per-open ceiling, not a percentile: assert the
    // worst sample for each surface.
    expect(report("override-dialog", dialog)).toBeLessThan(OPEN_BUDGET_MS);
    expect(report("launch-menu", menu)).toBeLessThan(OPEN_BUDGET_MS);
  },
  120_000,
);

describe("AP-TC-049 harness (smoke)", () => {
  // Sentinel so the file always contributes a passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  it.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});

describe("AP-TC-049: the override dialog stays cheap by construction", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("opens, and updates its trace, without any network round-trip", () => {
    openDialog();

    // Every layer the trace needs is already in the props, so the open does no
    // I/O: the 200ms budget is not competing with a request.
    expect(screen.getByTestId("launch-overrides-resolution").textContent).toContain("model=sonnet");
    expect(fetchSpy).not.toHaveBeenCalled();

    act(() => {
      fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "auto" } });
    });

    // The trace is recomputed from the same in-memory layers on every edit, so
    // the live update is not a request either.
    expect(screen.getByTestId("resolution-perLaunch-mode").textContent).toBe("mode=auto");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
