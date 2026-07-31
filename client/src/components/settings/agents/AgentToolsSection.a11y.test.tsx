// @vitest-environment jsdom
//
// AP-NFR-004: zero serious axe violations on the Agent tools section, in each
// of its states (built-ins only, a mixed list with an unresolved preset, and
// the open editor modal).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type {
  AgentPluginState,
  AgentToolPreset,
  JigMeta,
  ResolvedAgentPreset,
} from "@roubo/shared";
import { expectNoAxeFindings } from "../../../test/axe";

vi.mock("../../../hooks/useToast", () => ({ useToast: () => ({ addToast: vi.fn() }) }));

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
    saveAgentTool: vi.fn(),
    deleteAgentTool: vi.fn(),
    isLoading: false,
  });
}

function setResolved(presets: ResolvedAgentPreset[]) {
  mockedAppPresets.mockReturnValue({ data: { presets } } as ReturnType<typeof _useAppAgentPresets>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setPresets([]);
  setResolved([]);
});

describe("AgentToolsSection: axe-core", () => {
  it("has no axe violations with only the built-in presets", async () => {
    const { container } = render(
      <AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />,
    );
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations with a mixed list including an unresolved preset", async () => {
    setPresets([
      { id: "at-1", name: "Deep work", agent: "claude-code", params: { mode: "plan" } },
      { id: "at-2", name: "Quick fix", agent: "codex-cli" },
    ]);
    const { container } = render(
      <AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />,
    );
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations with a degraded built-in marked", async () => {
    setResolved([
      {
        id: "__builtin_agent_plan__",
        name: "Agent (Plan)",
        icon: "bot",
        source: "builtin",
        agent: "default",
        bindsDefaultAgent: true,
        agentPluginId: "claude-code",
        resolvedAgentName: "Claude Code",
        params: {},
        degraded: {
          droppedParams: ["mode"],
          message:
            'Agent tool "Agent (Plan)" drops mode, which Claude Code does not accept, so it launches as a plain agent.',
        },
      },
    ]);
    const { container } = render(
      <AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />,
    );
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations in the open editor modal", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);
    await user.click(screen.getByRole("button", { name: "New agent tool" }));
    expectNoAxeFindings(await axe(screen.getByRole("dialog")));
  });
});

describe("AgentToolEditorModal: keyboard operation (AP-TC-052)", () => {
  /** Open the editor exactly as a keyboard user does: Tab to the trigger, Enter. */
  async function openByKeyboard(user: ReturnType<typeof userEvent.setup>) {
    const trigger = screen.getByRole("button", { name: "New agent tool" });
    trigger.focus();
    await user.keyboard("{Enter}");
    return { trigger, dialog: await screen.findByRole("dialog") };
  }

  it("moves focus into a named modal dialog and traps it there (S001-O01)", async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>Outside</button>
        <AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />
      </>,
    );

    const { dialog } = await openByKeyboard(user);

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByRole("dialog", { name: "Agent tool" })).toBe(dialog);
    expect(dialog.contains(document.activeElement)).toBe(true);

    // Ten tabs is more than the dialog has controls, so a leak would have
    // escaped by now. The sibling outside is hidden from the tab order too.
    for (let step = 0; step < 10; step += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    const outside = screen.getByText("Outside");
    expect(outside.closest("[aria-hidden='true'],[inert]")).not.toBeNull();
  });

  it("closes on Escape and returns focus to the New agent tool trigger (S002-O01)", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);

    const { trigger } = await openByKeyboard(user);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).toBeNull();
    // React Aria restores focus on the frame after the scope unmounts, so the
    // assertion has to wait for it rather than read the same tick.
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it("completes the whole create flow by keyboard alone (S003-O01)", async () => {
    const user = userEvent.setup();
    const saveAgentTool = vi.fn();
    mockedAgentTools.mockReturnValue({
      agentTools: [],
      saveAgentTool,
      deleteAgentTool: vi.fn(),
      isLoading: false,
    });
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);

    await openByKeyboard(user);

    // Name, the bound agent, the two free-text params, the one param Claude
    // Code declares a closed set for, then the jig, then Save: every control
    // reached with Tab and set with the keyboard, no pointer anywhere.
    const pick = async (value: string) => {
      await user.selectOptions(document.activeElement as HTMLSelectElement, value);
    };

    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
    await user.keyboard("Deep work");

    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Agent"));
    await pick("claude-code");

    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Mode"));
    await pick("plan");

    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Jig"));
    await pick("refactor-pass");

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" }));
    await user.keyboard("{Enter}");

    expect(saveAgentTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Deep work",
        agent: "claude-code",
        params: { mode: "plan" },
        jig: "refactor-pass",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("announces a rejected name and ties it to the field (S003-O02)", async () => {
    const user = userEvent.setup();
    render(<AgentToolsSection agents={[CLAUDE]} defaultAgent={CLAUDE} jigs={JIGS} />);

    const { dialog } = await openByKeyboard(user);
    await user.click(screen.getByRole("button", { name: "Save" }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Name is required.");
    const name = screen.getByLabelText("Name");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")).toBe(alert.id);

    expectNoAxeFindings(await axe(dialog));
  });
});
