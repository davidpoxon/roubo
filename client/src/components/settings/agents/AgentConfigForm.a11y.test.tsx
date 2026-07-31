// @vitest-environment jsdom
//
// AP-TC-127 S001 / S002 / S003 and AP-NFR-005: one agent plugin's schema-driven
// config form, driven by keyboard alone. The AI Agents screen's whole point is
// this form, so the model / effort / mode selects and the free-text extra CLI
// arguments field are exercised here rather than only scanned in place by
// `AgentsTab.a11y.test.tsx`.
//
// Coverage gap (#703): contrast, the second half of S003-O01, is undecidable in
// jsdom, which computes no layout, so axe reports zero contrast violations even
// when text fails AA in a browser. Real-rendering color-contrast is therefore
// verified separately in the Playwright spec
// e2e/agent-plugins/agent-surfaces-contrast.spec.ts, which injects axe-core into
// Chromium and runs the color-contrast rule over the installed-agents section
// with both cards' config forms expanded, across both themes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { AgentPluginState } from "@roubo/shared";
import { expectNoAxeFindings } from "../../../test/axe";

vi.mock("../../../hooks/useAgentPlugins");

import { useSaveAgentConfig as _useSaveAgentConfig } from "../../../hooks/useAgentPlugins";
import AgentConfigForm from "./AgentConfigForm";

const mockedSave = vi.mocked(_useSaveAgentConfig);
const mutate = vi.fn();

/**
 * A manifest in the shape the shipping agent plugins actually use: `oneOf` of
 * titled consts for the closed choices, a plain string for the free-text extra
 * CLI arguments, plus an integer and a boolean so every control the renderer
 * knows how to draw is part of the scan.
 */
const CLAUDE: AgentPluginState = {
  id: "claude-code",
  name: "Claude Code",
  version: "1.2.0",
  configSchema: {
    type: "object",
    properties: {
      model: {
        title: "Model",
        oneOf: [
          { const: "opus", title: "Opus" },
          { const: "sonnet", title: "Sonnet" },
        ],
      },
      effort: {
        title: "Effort",
        oneOf: [
          { const: "high", title: "High" },
          { const: "low", title: "Low" },
        ],
      },
      mode: { title: "Mode", enum: ["plan", "auto"] },
      extraArgs: {
        type: "string",
        title: "Extra CLI arguments",
        description: "Appended verbatim to the agent's command line.",
      },
      maxTurns: { type: "integer", title: "Max turns" },
      verbose: { type: "boolean", title: "Verbose" },
    },
  },
  config: { model: "opus" },
  unavailable: null,
};

/** The select trigger's name is "<value> <label>", so anchor on the label. */
function selectTrigger(label: string) {
  return screen.getByRole("button", { name: new RegExp(`${label}$`) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSave.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
    typeof _useSaveAgentConfig
  >);
});

describe("AgentConfigForm: accessibility (AP-TC-127)", () => {
  it("gives every control an accessible name from the schema (S002-O01)", () => {
    render(<AgentConfigForm agent={CLAUDE} />);

    for (const label of ["Model", "Effort", "Mode"]) {
      expect(selectTrigger(label)).toBeDefined();
    }
    expect(screen.getByRole("textbox", { name: "Extra CLI arguments" })).toBeDefined();
    expect(screen.getByRole("spinbutton", { name: "Max turns" })).toBeDefined();
    expect(screen.getByRole("checkbox", { name: "Verbose" })).toBeDefined();
  });

  it("reaches every control by Tab, in the order they are rendered (S001-O01)", async () => {
    const user = userEvent.setup();
    render(<AgentConfigForm agent={CLAUDE} />);

    const expected = [
      selectTrigger("Model"),
      selectTrigger("Effort"),
      selectTrigger("Mode"),
      screen.getByRole("textbox", { name: "Extra CLI arguments" }),
      screen.getByRole("spinbutton", { name: "Max turns" }),
      screen.getByRole("checkbox", { name: "Verbose" }),
    ];

    for (const control of expected) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }
  });

  it("operates a closed-choice select by keyboard alone (S002-O01)", async () => {
    const user = userEvent.setup();
    render(<AgentConfigForm agent={CLAUDE} />);

    await user.tab();
    expect(document.activeElement).toBe(selectTrigger("Model"));
    await user.keyboard("{Enter}");

    const listbox = await screen.findByRole("listbox");
    // The manifest's titles, not its raw consts: the choice a user reads is the
    // one the plugin named (issue #1104).
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Opus", "Sonnet"]);

    await user.keyboard("{ArrowDown}{Enter}");

    expect(selectTrigger("Model").textContent).toContain("Sonnet");
  });

  it("types into the extra CLI arguments field and saves, keyboard only (S002-O01)", async () => {
    const user = userEvent.setup();
    render(<AgentConfigForm agent={CLAUDE} />);

    // Tab past the three selects onto the free-text field.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Extra CLI arguments" }),
    );
    await user.keyboard("--verbose");

    // Editing is what enables Save, so it only joins the tab order once the
    // draft is dirty. Reaching it from the edited field is the create flow.
    await user.tab();
    await user.tab();
    await user.tab();
    const save = screen.getByRole("button", { name: "Save defaults" });
    expect(document.activeElement).toBe(save);

    await user.keyboard("{Enter}");

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ extraArgs: "--verbose" }),
      expect.anything(),
    );
  });

  it("has no axe violations with every control rendered (S003-O01)", async () => {
    const { container } = render(<AgentConfigForm agent={CLAUDE} />);
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations when the plugin declares no fields (S003-O01)", async () => {
    const { container } = render(
      <AgentConfigForm agent={{ ...CLAUDE, configSchema: { type: "object", properties: {} } }} />,
    );
    expectNoAxeFindings(await axe(container));
  });
});
