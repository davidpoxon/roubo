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
import type { AgentPluginState, AgentToolPreset, JigMeta } from "@roubo/shared";

const toastMocks = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("../../../hooks/useToast", () => ({ useToast: () => ({ addToast: toastMocks.addToast }) }));

vi.mock("../../../hooks/useAgentTools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../hooks/useAgentTools")>();
  return { ...actual, useAgentTools: vi.fn() };
});

import { useAgentTools as _useAgentTools } from "../../../hooks/useAgentTools";
import AgentToolsSection from "./AgentToolsSection";

const mockedAgentTools = vi.mocked(_useAgentTools);
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

beforeEach(() => {
  vi.clearAllMocks();
  setPresets([]);
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

  it("summarises a preset's parameter overrides and jig behavior", () => {
    setPresets([
      { id: "at-1", name: "Deep work", agent: "claude-code", params: { mode: "plan" }, jig: "r1" },
    ]);
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    const row = screen.getAllByTestId("agent-tool-row").at(-1) as HTMLElement;
    expect(within(row).getByText(/plan · jig: r1/)).toBeTruthy();
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
