// @vitest-environment jsdom
/**
 * AP-TC-049 / AP-NFR-002: the settings and preset UI interactions each complete
 * in under 200ms.
 *
 * All three steps are measured here, because one test has to carry the bare
 * `AP-TC-049` and a case may not be corroborated on a subset of its
 * observations (#680, #682):
 *
 *   S001  a default-agent tile is selected, and every default-bound preset row
 *         re-resolves to the newly chosen agent
 *   S002  the preset editor modal opens and is interactive
 *   S003  the per-launch override dialog and the Terminal launch menu open
 *
 * S001's re-resolution is the synchronous one: `ProjectSettings` derives
 * `defaultAgent` on render and `AgentToolsSection` re-points every
 * `default`-bound row from it on the same paint. The background refetch
 * `useAppAgentPresets` performs on a default change carries only the advisory
 * degrade marker, so it is deliberately not what the budget is measured against.
 *
 * Same shape as the server-side AP-TC-048 harness: the wall-clock budget is
 * gated behind RUN_PERF_HARNESS=1 (jsdom render timings on a loaded CI box are
 * too noisy to gate a merge on), with a sentinel keeping the file contributing a
 * passing assertion under the default run.
 *
 * The non-gated structural tests pin the architectural properties the budgets
 * rest on: opening the override dialog performs no I/O at all (every layer it
 * needs is already in the props, so the trace is derived locally), and a
 * default-agent change re-points the preset rows without a round trip. A future
 * change that fetched either would regress AP-NFR-002 rather than merely slowing
 * a test.
 *
 * Neither describe below may name the case: the mapper matches `classname` plus
 * `name`, so an id in a describe is inherited by every child and would leave the
 * gated test tied with a skipped sentinel.
 */
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { Button, MenuTrigger } from "react-aria-components";
import type {
  AgentPluginState,
  ProjectAgentState,
  ResolvedAgentPreset,
  UserPreferences,
} from "@roubo/shared";
import { DEFAULT_JIG_SETTINGS, DEFAULT_CLAUDE_CODE_SETTINGS } from "@roubo/shared";

/**
 * A minimal live store standing in for the settings query, so a default-agent
 * change really does flow back through `useSettings` and re-render the page. A
 * `vi.fn()` mutation would leave the controlled `RadioGroup` on its old value
 * and there would be no re-resolution to time.
 */
const settingsStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let value: unknown;
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: () => value,
    set: (next: unknown) => {
      value = next;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSettings: () => ({
      settings: useSyncExternalStore(settingsStore.subscribe, settingsStore.get),
      isLoading: false,
      updateSettings: settingsStore.set,
    }),
    useRecheckClaudeCode: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  // Deep-links the settings page straight onto the Jigs tab, which is where the
  // default-agent picker and the Agent tools list live.
  useLocation: () => ({ hash: "#jigs" }),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("../hooks/useJigs", () => ({
  useGlobalJigs: () => ({ data: [] }),
  useDeleteGlobalJig: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDuplicateGlobalJig: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useUpdateGlobalJig: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("../hooks/useAgentPlugins", () => ({
  useAgentPlugins: () => ({ data: { agents: AGENT_PLUGINS }, isPending: false }),
}));

// Partial mock: `useAgentTools` itself stays real, projected over the store
// above, so a preset write and a default-agent change share one settings view.
// Only the app-scoped resolved-preset query is stubbed, to keep the harness off
// a real fetch (its `degraded` marker is advisory and not what S001 measures).
vi.mock("../hooks/useAgentTools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useAgentTools")>();
  return {
    ...actual,
    useAppAgentPresets: () => ({ data: undefined }) as ReturnType<typeof actual.useAppAgentPresets>,
  };
});

vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn() }),
}));

vi.mock("./jig-editor/jigIcons", () => ({
  getJigIcon: () => () => null,
  JIG_ICONS: [],
  JIG_ICON_MAP: {},
  DEFAULT_JIG_ICON: "file-text",
}));

vi.mock("./jig-editor/DeleteJigDialog", () => ({ default: () => null }));

import { renderWithProviders } from "../test/renderWithProviders";
import LaunchOverridesDialog from "./LaunchOverridesDialog";
import AgentLaunchMenu from "./AgentLaunchMenu";
import ProjectSettings from "./ProjectSettings";
import AgentToolsSection from "./settings/agents/AgentToolsSection";
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

/**
 * The registry shape the Settings surfaces read: an `AgentPluginState` carries
 * one flat `config`, unlike the launch surfaces' layered `ProjectAgentState`.
 * Two agents, because S001 is about moving the default from one to the other.
 */
const AGENT_PLUGINS: AgentPluginState[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["plan", "auto"] } },
    },
    config: { model: "opus", effort: "high" },
    unavailable: null,
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    configSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["plan", "auto"] } },
    },
    config: { model: "gpt-5" },
    unavailable: null,
  },
];

const BASE_SETTINGS = {
  theme: "dark",
  jigs: DEFAULT_JIG_SETTINGS,
  claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
} as UserPreferences;

/** Fresh settings: no persisted default, so nothing is selected on mount. */
function seedSettings() {
  settingsStore.set({ ...BASE_SETTINGS, jigs: { ...DEFAULT_JIG_SETTINGS } });
}

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

/**
 * S001: the click on a default-agent tile through to the tile reading as
 * selected AND every default-bound preset row naming the new agent.
 */
function timeDefaultAgentSelect(): number {
  seedSettings();
  const { unmount } = renderWithProviders(<ProjectSettings />);
  const group = screen.getByRole("radiogroup", { name: "Default agent" });
  const codex = within(group).getByRole("radio", { name: /Codex CLI/ });

  const started = performance.now();
  act(() => {
    fireEvent.click(codex);
  });
  // Selected state, then the re-resolution. The built-in preset rows render
  // their binding from the resolved default, so that line is the observable
  // proof the change propagated rather than merely being stored.
  const selected = within(screen.getByRole("radiogroup", { name: "Default agent" }))
    .getAllByRole("radio")
    .filter((radio) => (radio as HTMLInputElement).checked);
  const resolved = screen.getAllByText(/default agent → Codex CLI/);
  const elapsed = performance.now() - started;

  if (selected.length !== 1) throw new Error("Expected exactly one selected default-agent tile");
  if (resolved.length === 0) throw new Error("No preset row re-resolved to the new default agent");
  unmount();
  return elapsed;
}

/** S002: pressing New agent tool through to the editor being interactive. */
function timePresetEditorOpen(): number {
  seedSettings();
  const { unmount } = renderWithProviders(
    <AgentToolsSection agents={AGENT_PLUGINS} defaultAgent={AGENT_PLUGINS[0]} jigs={[]} />,
  );
  const trigger = screen.getByRole("button", { name: "New agent tool" });

  const started = performance.now();
  act(() => {
    fireEvent.click(trigger);
  });
  // Interactive means the form is there to be driven, so the first field's
  // query is part of the measurement rather than an afterthought.
  const dialog = screen.getByRole("dialog");
  within(dialog).getByLabelText("Name");
  const elapsed = performance.now() - started;

  unmount();
  return elapsed;
}

/** S003: one override-dialog open-to-interactive, primary control queryable. */
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

/** S003: the Terminal launch menu, from the trigger press to a rendered menu. */
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

function report(step: string, label: string, samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const worst = sorted[sorted.length - 1] ?? 0;
  console.log(
    JSON.stringify(
      {
        kind: "perf-evidence",
        tc: "AP-TC-049",
        step,
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
  "AP-TC-049: every settings and launch-surface interaction stays under 200ms",
  () => {
    // Warmup so first-render module cost does not land in the sample.
    timeDefaultAgentSelect();
    timePresetEditorOpen();
    timeDialogOpen();
    timeMenuOpen();

    const defaultAgent: number[] = [];
    const presetEditor: number[] = [];
    const dialog: number[] = [];
    const menu: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      defaultAgent.push(timeDefaultAgentSelect());
      presetEditor.push(timePresetEditorOpen());
      dialog.push(timeDialogOpen());
      menu.push(timeMenuOpen());
    }

    // Every observation of AP-TC-049 is a per-interaction ceiling, not a
    // percentile, so each surface is asserted on its worst sample.
    expect(report("S001", "default-agent-select", defaultAgent)).toBeLessThan(OPEN_BUDGET_MS); // S001-O01
    expect(report("S002", "preset-editor", presetEditor)).toBeLessThan(OPEN_BUDGET_MS); // S002-O01
    expect(report("S003", "override-dialog", dialog)).toBeLessThan(OPEN_BUDGET_MS); // S003-O01
    expect(report("S003", "launch-menu", menu)).toBeLessThan(OPEN_BUDGET_MS); // S003-O01
  },
  240_000,
);

describe("launch-surface perf harness (smoke)", () => {
  // Sentinel so the file always contributes a passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  it.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});

describe("the override dialog stays cheap by construction", () => {
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

describe("a default-agent change re-resolves the preset rows on the same paint", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // The property the S001 budget rests on: the rows are derived from the
  // resolved default on render, so nothing has to be fetched for them to catch
  // up with a new default.
  it("re-points every default-bound preset row without a network round-trip", () => {
    seedSettings();
    renderWithProviders(<ProjectSettings />);

    const group = screen.getByRole("radiogroup", { name: "Default agent" });
    act(() => {
      fireEvent.click(within(group).getByRole("radio", { name: /Codex CLI/ }));
    });

    expect(screen.getAllByText(/default agent → Codex CLI/).length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
