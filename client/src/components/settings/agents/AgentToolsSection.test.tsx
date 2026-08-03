// @vitest-environment jsdom
//
// The Agent tools section of Settings, Jigs (AP-FR-008, AP-FR-009, issue #516).
// Covers AP-TC-025 (a preset records its binding, params and jig behavior),
// AP-TC-031 / AP-TC-039 / AP-TC-045 (default-bound presets re-resolve when the
// default agent changes), AP-TC-032 (an uninstalled plugin is flagged),
// AP-TC-040 (cancel discards) and AP-TC-044 (mixed list resolution).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AgentPluginState,
  AgentToolPreset,
  JigMeta,
  ResolvedAgentPreset,
} from "@roubo/shared";

const toastMocks = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("../../../hooks/useToast", () => ({ useToast: () => ({ addToast: toastMocks.addToast }) }));

vi.mock("../../../hooks/useAgentTools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../hooks/useAgentTools")>();
  return { ...actual, useAgentTools: vi.fn(), useAppAgentPresets: vi.fn() };
});

import {
  useAgentTools as _useAgentTools,
  useAppAgentPresets as _useAppAgentPresets,
} from "../../../hooks/useAgentTools";
import AgentToolsSection from "./AgentToolsSection";

const mockedAgentTools = vi.mocked(_useAgentTools);
const mockedAppPresets = vi.mocked(_useAppAgentPresets);
const saveAgentTool = vi.fn();
const deleteAgentTool = vi.fn();

const CLAUDE: AgentPluginState = {
  id: "claude-code",
  name: "Claude Code",
  configSchema: {
    type: "object",
    properties: { mode: { type: "string", enum: ["plan", "auto"] } },
  },
  config: {},
  unavailable: null,
};
const CODEX: AgentPluginState = {
  id: "codex-cli",
  name: "Codex CLI",
  config: {},
  unavailable: null,
};
/**
 * The same closed set as `CLAUDE`, spelled the way every shipping agent manifest
 * spells it: a `oneOf` of `{ const, title }` branches, so each choice carries
 * its own display title. `agent-params.test.ts` covers the helper's reading of
 * both spellings; this fixture is what proves the editor RENDERS the titled one.
 */
const CLAUDE_TITLED: AgentPluginState = {
  ...CLAUDE,
  configSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        oneOf: [
          { const: "plan", title: "Plan" },
          { const: "auto", title: "Auto" },
        ],
      },
    },
  },
};

const JIGS: JigMeta[] = [
  {
    id: "refactor-pass",
    name: "Refactor pass",
    description: "Structured refactoring",
    icon: "file-text",
    source: "app",
  } as JigMeta,
];

function setPresets(agentTools: AgentToolPreset[]) {
  mockedAgentTools.mockReturnValue({
    agentTools,
    saveAgentTool,
    deleteAgentTool,
    isLoading: false,
  });
}

/**
 * The server's resolved view of the same list (issue #672). Only `id` and
 * `degraded` are read by the section, so a case supplies just the entries it
 * cares about; a preset the response omits simply carries no marker.
 */
function setResolved(presets: ResolvedAgentPreset[]) {
  mockedAppPresets.mockReturnValue({ data: { presets } } as ReturnType<typeof _useAppAgentPresets>);
}

function degradedBuiltin(id: string, name: string, droppedParams: string[]): ResolvedAgentPreset {
  return {
    id,
    name,
    icon: "bot",
    source: "builtin",
    agent: "default",
    bindsDefaultAgent: true,
    agentPluginId: "claude-code",
    resolvedAgentName: "Claude Code",
    params: {},
    degraded: {
      droppedParams,
      message: `Agent tool "${name}" drops ${droppedParams.join(", ")}, which Claude Code does not accept, so it launches as a plain agent.`,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setPresets([]);
  setResolved([]);
});

describe("AgentToolsSection", () => {
  it("lists the three built-in presets, each marked built-in", () => {
    render(<AgentToolsSection agents={[CLAUDE, CODEX]} defaultAgent={CLAUDE} jigs={JIGS} />);
    const rows = screen.getAllByTestId("agent-tool-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).getByText(/^Agent/).textContent)).toEqual([
      "Agent",
      "Agent (Plan)",
      "Agent (Auto)",
    ]);
    expect(screen.getAllByText("built-in")).toHaveLength(3);
  });

  // AP-TC-027, AP-TC-044: a default-bound preset renders the arrow form.
  it("renders default-bound presets as 'default agent -> <resolved>'", () => {
    render(<AgentToolsSection agents={[CLAUDE, CODEX]} defaultAgent={CLAUDE} jigs={JIGS} />);
    expect(screen.getAllByText(/default agent → Claude Code/)).toHaveLength(3);
  });

  // AP-TC-031, AP-TC-039, AP-TC-045: resolution is computed on render, so the
  // list follows the default without any stored value to invalidate.
  it("re-resolves default-bound presets when the default agent changes", () => {
    const { rerender } = render(
      <AgentToolsSection agents={[CLAUDE, CODEX]} defaultAgent={CLAUDE} jigs={JIGS} />,
    );
    expect(screen.getAllByText(/default agent → Claude Code/)).toHaveLength(3);
    rerender(<AgentToolsSection agents={[CLAUDE, CODEX]} defaultAgent={CODEX} jigs={JIGS} />);
    expect(screen.getAllByText(/default agent → Codex CLI/)).toHaveLength(3);
    expect(screen.queryByText(/default agent → Claude Code/)).toBeNull();
  });

  // AP-TC-044: a plugin-bound preset stays on its agent whatever the default is.
  it("leaves plugin-bound presets pinned when the default agent changes", () => {
    setPresets([{ id: "at-1", name: "Quick fix", agent: "codex-cli" }]);
    const { rerender } = render(
      <AgentToolsSection agents={[CLAUDE, CODEX]} defaultAgent={CLAUDE} jigs={JIGS} />,
    );
    const row = screen.getAllByTestId("agent-tool-row").at(-1) as HTMLElement;
    expect(within(row).getByText(/Codex CLI/)).toBeTruthy();
    rerender(<AgentToolsSection agents={[CLAUDE, CODEX]} defaultAgent={CODEX} jigs={JIGS} />);
    const after = screen.getAllByTestId("agent-tool-row").at(-1) as HTMLElement;
    expect(within(after).getByText(/Codex CLI/)).toBeTruthy();
    expect(within(after).queryByTestId("agent-tool-unresolved")).toBeNull();
  });

  // AP-TC-032: an uninstalled plugin is flagged rather than silently rendering
  // as if it were a valid agent.
  it("flags a preset bound to an uninstalled plugin", () => {
    setPresets([{ id: "at-1", name: "Quick fix", agent: "codex-cli" }]);
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    const row = screen.getAllByTestId("agent-tool-row").at(-1) as HTMLElement;
    expect(within(row).getByTestId("agent-tool-unresolved").textContent).toContain("codex-cli");
  });

  it("flags built-ins when no default agent is configured", () => {
    render(<AgentToolsSection agents={[]} jigs={JIGS} />);
    expect(screen.getAllByTestId("agent-tool-unresolved")).toHaveLength(3);
  });

  // AP-TC-024 S003-O02: a pinned jig reads as its display name, unprefixed.
  it("summarises a preset's parameter overrides and jig behavior", () => {
    setPresets([
      {
        id: "at-1",
        name: "Deep work",
        agent: "claude-code",
        params: { mode: "plan" },
        jig: "refactor-pass",
      },
    ]);
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    const row = screen.getAllByTestId("agent-tool-row").at(-1) as HTMLElement;
    expect(within(row).getByText(/plan · Refactor pass/)).toBeTruthy();
  });

  // A jig that no longer resolves still shows, by id: better a stale id than a
  // row that silently stops mentioning the jig it is still pinned to.
  it("falls back to the jig id when the pinned jig is gone", () => {
    setPresets([
      { id: "at-1", name: "Deep work", agent: "claude-code", params: { mode: "plan" }, jig: "r1" },
    ]);
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    const row = screen.getAllByTestId("agent-tool-row").at(-1) as HTMLElement;
    expect(within(row).getByText(/plan · r1/)).toBeTruthy();
  });

  // AP-TC-025: the editor records binding, params and jig behavior.
  it("saves a new preset with its agent binding, params and jig behavior", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE, CODEX]} defaultAgent={CLAUDE} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "New agent tool" }));

    await user.type(screen.getByLabelText("Name"), "Deep work");
    await user.selectOptions(screen.getByLabelText("Agent"), "claude-code");
    await user.selectOptions(screen.getByLabelText("Mode"), "plan");
    await user.selectOptions(screen.getByLabelText("Jig"), "refactor-pass");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(saveAgentTool).toHaveBeenCalledTimes(1);
    expect(saveAgentTool.mock.calls[0][0]).toMatchObject({
      name: "Deep work",
      agent: "claude-code",
      params: { mode: "plan" },
      jig: "refactor-pass",
    });
    expect(saveAgentTool.mock.calls[0][0].id).toBeTruthy();
    expect(toastMocks.addToast).toHaveBeenCalledWith("Agent tool saved.");
  });

  it("omits the jig key when the editor leaves it on inherit", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "New agent tool" }));
    await user.type(screen.getByLabelText("Name"), "Plain");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveAgentTool.mock.calls[0][0].jig).toBeUndefined();
  });

  // AP-TC-040: cancel discards, with no toast and no list entry.
  it("discards an unsaved preset on cancel", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "New agent tool" }));
    await user.type(screen.getByLabelText("Name"), "Scratch");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(saveAgentTool).not.toHaveBeenCalled();
    expect(toastMocks.addToast).not.toHaveBeenCalled();
    expect(screen.queryByText("Scratch")).toBeNull();
    expect(screen.getAllByTestId("agent-tool-row")).toHaveLength(3);
  });

  it("refuses to save a preset with no name", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "New agent tool" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveAgentTool).not.toHaveBeenCalled();
    expect(screen.getByText("Name is required.")).toBeTruthy();
  });

  it("edits an existing preset in place", async () => {
    const user = userEvent.setup();
    setPresets([{ id: "at-1", name: "Deep work", agent: "claude-code" }]);
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "Edit Deep work" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Deeper work");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveAgentTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "at-1", name: "Deeper work" }),
    );
  });

  // AP-TC-032 in the editor (issue #650): the binding of a preset whose plugin
  // is not installed stays named in the select and survives a save that never
  // touched the field, rather than reading as "Default agent" and being
  // rewritten to it.
  it("keeps an uninstalled agent binding named in the editor and intact on save", async () => {
    const user = userEvent.setup();
    setPresets([{ id: "at-1", name: "Quick fix", agent: "codex-cli" }]);
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "Edit Quick fix" }));

    const select = screen.getByLabelText("Agent") as HTMLSelectElement;
    expect(select.value).toBe("codex-cli");
    expect(select.selectedOptions[0]?.textContent).toBe("codex-cli (not installed)");

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveAgentTool).toHaveBeenCalledWith(
      expect.objectContaining({ id: "at-1", name: "Quick fix", agent: "codex-cli" }),
    );
  });

  it("deletes a preset", async () => {
    const user = userEvent.setup();
    setPresets([{ id: "at-1", name: "Deep work", agent: "claude-code" }]);
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "Delete Deep work" }));
    expect(deleteAgentTool).toHaveBeenCalledWith("at-1");
  });

  it("offers no edit or delete control on a built-in preset", () => {
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    expect(screen.queryByRole("button", { name: "Edit Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Agent" })).toBeNull();
  });

  // Issue #672: the server's advisory `degraded` field, surfaced here rather
  // than re-derived, so Settings stops presenting `Agent (Plan)` as if the
  // bound agent honoured its mode.
  describe("degraded built-ins", () => {
    it("marks a degraded built-in with the params the bound agent dropped", () => {
      setResolved([degradedBuiltin("__builtin_agent_plan__", "Agent (Plan)", ["mode"])]);
      render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);

      const rows = screen.getAllByTestId("agent-tool-row");
      const plan = rows[1] as HTMLElement;
      const notice = within(plan).getByTestId("agent-tool-degraded");
      expect(notice.textContent).toContain("drops mode");
      expect(notice.textContent).toContain("launches as a plain agent");
      // Advisory only: the row is not flagged as unlaunchable.
      expect(within(plan).queryByTestId("agent-tool-unresolved")).toBeNull();
    });

    it("leaves the other built-ins unmarked", () => {
      setResolved([degradedBuiltin("__builtin_agent_plan__", "Agent (Plan)", ["mode"])]);
      render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
      expect(screen.getAllByTestId("agent-tool-degraded")).toHaveLength(1);
    });

    it("keeps a degraded app-level preset editable and deletable", async () => {
      const user = userEvent.setup();
      setPresets([
        { id: "at-1", name: "Deep work", agent: "claude-code", params: { mode: "plan" } },
      ]);
      setResolved([
        { ...degradedBuiltin("at-1", "Deep work", ["mode"]), source: "app", agent: "claude-code" },
      ]);
      render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);

      const row = screen.getAllByTestId("agent-tool-row").at(-1) as HTMLElement;
      expect(within(row).getByTestId("agent-tool-degraded")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Edit Deep work" }));
      expect(screen.getByLabelText("Name")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await user.click(screen.getByRole("button", { name: "Delete Deep work" }));
      expect(deleteAgentTool).toHaveBeenCalledWith("at-1");
    });

    it("renders the listing unchanged while the resolved presets are unavailable", () => {
      // In flight, or the request failed. The marker is advisory, so its absence
      // must not hold the listing back.
      mockedAppPresets.mockReturnValue({ data: undefined } as ReturnType<
        typeof _useAppAgentPresets
      >);
      render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
      expect(screen.getAllByTestId("agent-tool-row")).toHaveLength(3);
      expect(screen.queryByTestId("agent-tool-degraded")).toBeNull();
    });

    it("drops the marker when a preset also fails to resolve", () => {
      // The server never sets both, but a stale response paired with a fresh
      // client-side unresolved verdict must not show two conflicting notices.
      setResolved([degradedBuiltin("__builtin_agent_plan__", "Agent (Plan)", ["mode"])]);
      render(<AgentToolsSection agents={[]} jigs={JIGS} />);
      expect(screen.getAllByTestId("agent-tool-unresolved")).toHaveLength(3);
      expect(screen.queryByTestId("agent-tool-degraded")).toBeNull();
    });
  });

  // AP-TC-025 S002-O01 at the component level. The e2e spec asserts the same
  // thing against the real overlay manifest; this pins it in jsdom, where the
  // option labels are cheap to read, so a regression that rendered the raw
  // consts (the free-text helper's old reading of the schema) fails here first.
  it("renders a titled select for an agent spelling its choices as oneOf", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE_TITLED]} defaultAgent={CLAUDE_TITLED} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "New agent tool" }));

    const mode = screen.getByLabelText("Mode");
    expect(mode.tagName).toBe("SELECT");
    // The branch titles, not the raw consts, plus the inherit entry that leaves
    // an untouched override falling through to the layers beneath it.
    expect(
      Array.from(mode.querySelectorAll("option")).map((o) => [o.value, o.textContent]),
    ).toEqual([
      ["", "inherit"],
      ["plan", "Plan"],
      ["auto", "Auto"],
    ]);

    await user.type(screen.getByLabelText("Name"), "Deep work");
    await user.selectOptions(mode, "plan");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // The const is what gets written, never the title.
    expect(saveAgentTool.mock.calls[0][0].params).toEqual({ mode: "plan" });
  });

  it("renders a free-text parameter control for an agent declaring no enum", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE, CODEX]} defaultAgent={CODEX} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "New agent tool" }));
    await user.type(screen.getByLabelText("Name"), "Codex run");
    await user.type(screen.getByLabelText("Mode"), "auto");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saveAgentTool.mock.calls[0][0].params).toEqual({ mode: "auto" });
  });
});
