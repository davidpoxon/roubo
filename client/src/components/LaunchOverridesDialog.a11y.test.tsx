// @vitest-environment jsdom
//
// AP-NFR-005: zero serious axe violations on the per-launch override dialog, in
// both the states the user can encounter (a fresh open, and after the draft has
// been filled in so the Resolution panel carries superseded and emphasised
// values). The modality semantics are asserted alongside, since React Aria omits
// `aria-modal` and the dialog stamps it through a ref (see lib/aria-modal.ts).

import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import type { ProjectAgentState, ResolvedAgentPreset } from "@roubo/shared";
import LaunchOverridesDialog from "./LaunchOverridesDialog";
import { resolveLaunchTarget } from "./settings/agents/agent-launchability";
import { expectNoAxeFindings } from "../test/axe";

const CLAUDE: ProjectAgentState = {
  id: "claude-code",
  name: "Claude Code",
  configSchema: {
    properties: {
      model: { enum: ["opus", "sonnet", "haiku"] },
      mode: { enum: ["plan", "auto"] },
    },
  },
  appDefaults: { model: "opus", effort: "high", mode: "plan" },
  overrides: { model: "sonnet" },
  effective: { model: "sonnet", effort: "high", mode: "plan" },
  unavailable: null,
  misconfigured: null,
};

/** A selectable preset, so the preset picker (issue #668) is part of the scan. */
const PRESET: ResolvedAgentPreset = {
  id: "at-deep",
  name: "Deep work",
  icon: "bot",
  source: "app",
  agent: "claude-code",
  bindsDefaultAgent: false,
  agentPluginId: "claude-code",
  resolvedAgentName: "Claude Code",
  params: { mode: "plan" },
};

function open(onLaunch: () => void = vi.fn()) {
  return render(
    <LaunchOverridesDialog
      isOpen
      agents={[CLAUDE]}
      presets={[PRESET]}
      resolveTarget={(preset) => resolveLaunchTarget(preset, [CLAUDE], undefined)}
      initialPresetId={PRESET.id}
      onCancel={vi.fn()}
      onLaunch={onLaunch}
    />,
  );
}

describe("LaunchOverridesDialog: axe-core (AP-NFR-005)", () => {
  it("has no axe violations on open", async () => {
    // React Aria's Modal portals outside the render container; scan the whole
    // document body so the dialog markup is included.
    const { baseElement } = open();
    expectNoAxeFindings(await axe(baseElement));
  });

  it("has no axe violations with a filled-in draft", async () => {
    const { baseElement } = open();

    act(() => {
      fireEvent.change(screen.getByLabelText("Model"), { target: { value: "haiku" } });
    });
    act(() => {
      fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "max" } });
    });

    expectNoAxeFindings(await axe(baseElement));
  });

  it("carries modal semantics and a title, and traps focus inside the dialog", () => {
    // The dialog is rendered beside a focusable sibling on purpose. With the
    // dialog alone, "everything focusable is inside it" holds trivially and
    // would still pass with the modal wrapper removed, so the trap assertion
    // needs something outside the dialog that it could otherwise escape to.
    render(
      <>
        <button>Outside</button>
        <LaunchOverridesDialog
          isOpen
          agents={[CLAUDE]}
          presets={[PRESET]}
          resolveTarget={(preset) => resolveLaunchTarget(preset, [CLAUDE], undefined)}
          initialPresetId={PRESET.id}
          onCancel={vi.fn()}
          onLaunch={vi.fn()}
        />
      </>,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // The title is the dialog's accessible name, via RAC's `slot="title"`.
    expect(screen.getByRole("dialog", { name: "Launch with overrides" })).toBe(dialog);

    // React Aria hides the rest of the document behind the modal, so the
    // sibling is both outside the dialog and unreachable while it is open.
    const outside = screen.getByText("Outside");
    expect(dialog.contains(outside)).toBe(false);
    expect(outside.closest("[aria-hidden='true'],[inert]")).not.toBeNull();
  });
});

describe("LaunchOverridesDialog: keyboard operation (AP-TC-053)", () => {
  it("tabs through every control and launches with the keyboard (S001-O01, S002-O01)", async () => {
    const user = userEvent.setup();
    const onLaunch = vi.fn();
    open(onLaunch);

    // Preset, Agent, then the three param controls, then Cancel and Launch:
    // the whole dialog in tab order, each one named.
    const order = [
      screen.getByLabelText("Preset"),
      screen.getByLabelText("Agent"),
      screen.getByLabelText("Model"),
      screen.getByLabelText("Effort"),
      screen.getByLabelText("Mode"),
      screen.getByRole("button", { name: "Cancel" }),
      screen.getByRole("button", { name: "Launch session" }),
    ];

    for (const control of order) {
      await user.tab();
      expect(document.activeElement).toBe(control);
    }

    // Focus already sits on Launch session, so Enter finishes the flow without
    // a pointer ever being used.
    await user.keyboard("{Enter}");

    expect(onLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "claude-code", agentName: "Claude Code" }),
    );
  });

  it("sets a param by keyboard alone and the trace follows (S001-O01)", async () => {
    const user = userEvent.setup();
    open();

    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText("Model"));
    await user.selectOptions(document.activeElement as HTMLSelectElement, "haiku");

    expect(screen.getByTestId("resolution-perLaunch-model").textContent).toBe("model=haiku");
  });

  it("exposes the Resolution trace as a named group (S001-O01)", () => {
    open();

    // Anonymous divs would leave the trace lines unattributed; the caption has
    // to name the group that carries them.
    const panel = screen.getByRole("group", { name: "Resolution" });
    expect(panel).toBe(screen.getByTestId("launch-overrides-resolution"));
    expect(panel.textContent).toContain("app default");
    expect(panel.textContent).toContain("this launch");
  });
});
