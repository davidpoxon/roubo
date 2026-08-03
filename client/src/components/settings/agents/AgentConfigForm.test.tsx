// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentPluginState } from "@roubo/shared";

vi.mock("../../../hooks/useAgentPlugins");

import { useSaveAgentConfig as _useSaveAgentConfig } from "../../../hooks/useAgentPlugins";
import { ApiError } from "../../../lib/api";
import AgentConfigForm from "./AgentConfigForm";

const mockedSave = vi.mocked(_useSaveAgentConfig);

type MutateOptions = {
  onSuccess?: (result: { pluginId: string; config: Record<string, unknown> }) => void;
  onError?: (err: unknown) => void;
};

/** A per-plugin save stub that echoes the posted config back as "saved". */
function stubSave(saves: Record<string, Record<string, unknown>[]>) {
  mockedSave.mockImplementation((pluginId: string) => {
    const mutate = (config: Record<string, unknown>, opts?: MutateOptions) => {
      (saves[pluginId] ??= []).push(config);
      opts?.onSuccess?.({ pluginId, config });
    };
    return { mutate, isPending: false } as unknown as ReturnType<typeof _useSaveAgentConfig>;
  });
}

function agent(over: Partial<AgentPluginState> = {}): AgentPluginState {
  return {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string", title: "Model", enum: ["sonnet", "opus"] },
        note: { type: "string", title: "Note" },
      },
    },
    config: {},
    unavailable: null,
    ...over,
  };
}

/**
 * The four closed-choice params the shipped Codex plugin declares, in the
 * `oneOf: [{ const, title }]` spelling its manifest uses (copied from
 * roubo-plugins/plugins/codex/roubo-plugin.yaml). AP-TC-106 is about this
 * specific form persisting, so the fixture has to be the real shape rather
 * than the two-property generic one `agent()` returns.
 */
function codexAgent(over: Partial<AgentPluginState> = {}): AgentPluginState {
  const choice = (title: string, branches: [string, string][]) => ({
    type: "string",
    title,
    oneOf: branches.map(([c, t]) => ({ const: c, title: t })),
  });
  return {
    id: "codex-cli",
    name: "Codex CLI",
    version: "0.2.0",
    configSchema: {
      type: "object",
      properties: {
        model: choice("Model", [
          ["gpt-5.2-codex", "GPT-5.2 Codex"],
          ["gpt-5.1-codex", "GPT-5.1 Codex"],
        ]),
        effort: choice("Reasoning effort", [
          ["low", "Low"],
          ["medium", "Medium"],
          ["high", "High"],
        ]),
        approvalPolicy: choice("Approval policy", [
          ["untrusted", "Untrusted"],
          ["on-request", "On request"],
          ["never", "Never"],
        ]),
        sandbox: choice("Sandbox", [
          ["read-only", "Read only"],
          ["workspace-write", "Workspace write"],
        ]),
      },
    },
    config: {},
    unavailable: null,
    ...over,
  };
}

function childOf<T extends Element>(container: HTMLElement, selector: string): T {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(`No ${selector} inside ${container.dataset.testid ?? "container"}`);
  return found;
}

async function pickOption(user: ReturnType<typeof userEvent.setup>, key: string, label: string) {
  await user.click(childOf<HTMLButtonElement>(screen.getByTestId(`config-field-${key}`), "button"));
  await user.click(await screen.findByRole("option", { name: label }));
}

async function pickModel(user: ReturnType<typeof userEvent.setup>, label: string) {
  await pickOption(user, "model", label);
}

/**
 * The value a config select is actually SHOWING. `config-field-*` also contains
 * react-aria's hidden native <select>, which carries every option in the schema,
 * so asserting text content over the whole container matches any option label
 * whether or not it is the selected one. These two read the selection itself:
 * the hidden select's value, and the trigger's visible label.
 */
function selectedValue(key: string): string {
  const field = screen.getByTestId(`config-field-${key}`);
  return childOf<HTMLSelectElement>(field, '[data-testid="hidden-select-container"] select').value;
}

function selectedLabel(key: string): string {
  const field = screen.getByTestId(`config-field-${key}`);
  return childOf<HTMLElement>(field, "button > span").textContent ?? "";
}

beforeEach(() => {
  stubSave({});
});

describe("AgentConfigForm", () => {
  it("renders an enum property as a select of its allowed values (AP-TC-004)", async () => {
    const user = userEvent.setup();
    render(<AgentConfigForm agent={agent()} />);

    await user.click(
      childOf<HTMLButtonElement>(screen.getByTestId("config-field-model"), "button"),
    );
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["sonnet", "opus"]);
  });

  it("disables Save and Reset until the draft diverges from the saved config", async () => {
    const user = userEvent.setup();
    render(<AgentConfigForm agent={agent({ config: { model: "sonnet" } })} />);

    expect(screen.getByTestId("agent-config-save-claude-code")).toBeDisabled();
    expect(screen.getByTestId("agent-config-reset-claude-code")).toBeDisabled();

    await pickModel(user, "opus");
    expect(screen.getByTestId("agent-config-save-claude-code")).not.toBeDisabled();
  });

  it("persists the draft on Save and treats the result as the new last-saved (AP-TC-006)", async () => {
    const user = userEvent.setup();
    const saves: Record<string, Record<string, unknown>[]> = {};
    stubSave(saves);
    render(<AgentConfigForm agent={agent({ config: { model: "sonnet" } })} />);

    await pickModel(user, "opus");
    await user.click(screen.getByTestId("agent-config-save-claude-code"));

    expect(saves["claude-code"]).toEqual([{ model: "opus" }]);
    expect(screen.getByText("Saved.")).toBeInTheDocument();
    // Save is the new baseline: nothing further is dirty.
    expect(screen.getByTestId("agent-config-save-claude-code")).toBeDisabled();
  });

  it("reverts an unsaved edit to the last-saved values on Reset (AP-TC-006)", async () => {
    const user = userEvent.setup();
    render(<AgentConfigForm agent={agent({ config: { model: "sonnet" } })} />);

    await pickModel(user, "opus");
    expect(selectedValue("model")).toBe("opus");

    await user.click(screen.getByTestId("agent-config-reset-claude-code"));
    expect(selectedValue("model")).toBe("sonnet");
    expect(screen.getByTestId("agent-config-reset-claude-code")).toBeDisabled();
  });

  it("resets to the last SAVED values, not the values the form first mounted with", async () => {
    const user = userEvent.setup();
    render(<AgentConfigForm agent={agent({ config: { model: "sonnet" } })} />);

    await pickModel(user, "opus");
    await user.click(screen.getByTestId("agent-config-save-claude-code"));
    await pickModel(user, "sonnet");
    await user.click(screen.getByTestId("agent-config-reset-claude-code"));

    expect(selectedValue("model")).toBe("opus");
  });

  it("renders a server field error inline against the offending control (AP-TC-011)", async () => {
    const user = userEvent.setup();
    mockedSave.mockImplementation(
      () =>
        ({
          mutate: (_config: Record<string, unknown>, opts?: MutateOptions) => {
            opts?.onError?.(
              new ApiError("Invalid agent configuration", 400, undefined, {
                fieldErrors: [{ path: "model", message: "Must be one of: sonnet, opus" }],
              }),
            );
          },
          isPending: false,
        }) as unknown as ReturnType<typeof _useSaveAgentConfig>,
    );
    render(<AgentConfigForm agent={agent({ config: { model: "sonnet" } })} />);

    await pickModel(user, "opus");
    await user.click(screen.getByTestId("agent-config-save-claude-code"));

    const form = within(screen.getByTestId("agent-config-form-claude-code"));
    expect(form.getByRole("alert")).toHaveTextContent("Must be one of: sonnet, opus");
  });

  it("surfaces a field error naming a property the form renders no control for (#634)", async () => {
    const user = userEvent.setup();
    mockedSave.mockImplementation(
      () =>
        ({
          mutate: (_config: Record<string, unknown>, opts?: MutateOptions) => {
            opts?.onError?.(
              new ApiError("Invalid agent configuration", 400, undefined, {
                fieldErrors: [{ path: "nonsense", message: "Unexpected property 'nonsense'" }],
              }),
            );
          },
          isPending: false,
        }) as unknown as ReturnType<typeof _useSaveAgentConfig>,
    );
    render(<AgentConfigForm agent={agent({ config: { model: "sonnet" } })} />);

    await pickModel(user, "opus");
    await user.click(screen.getByTestId("agent-config-save-claude-code"));

    expect(screen.getByTestId("agent-config-error-claude-code")).toHaveTextContent(
      "Unexpected property 'nonsense'",
    );
  });

  it("keeps two mounted plugins' drafts and saves independent (AP-TC-003, AP-TC-009)", async () => {
    const user = userEvent.setup();
    const saves: Record<string, Record<string, unknown>[]> = {};
    stubSave(saves);

    const codex = agent({
      id: "codex-cli",
      name: "Codex CLI",
      configSchema: {
        type: "object",
        properties: { note: { type: "string", title: "Note" } },
      },
      config: { note: "codex" },
    });

    render(
      <>
        <AgentConfigForm agent={agent({ config: { note: "claude" } })} />
        <AgentConfigForm agent={codex} />
      </>,
    );

    const claudeForm = within(screen.getByTestId("agent-config-form-claude-code"));
    const codexForm = within(screen.getByTestId("agent-config-form-codex-cli"));
    const claudeNote = childOf<HTMLInputElement>(
      claudeForm.getByTestId("config-field-note"),
      "input",
    );
    const codexNote = childOf<HTMLInputElement>(
      codexForm.getByTestId("config-field-note"),
      "input",
    );

    // Interleave: edit one, edit the other, save one, save the other.
    await user.type(claudeNote, "-a");
    await user.type(codexNote, "-b");
    await user.click(screen.getByTestId("agent-config-save-claude-code"));
    await user.click(screen.getByTestId("agent-config-save-codex-cli"));

    expect(saves["claude-code"]).toEqual([{ note: "claude-a" }]);
    expect(saves["codex-cli"]).toEqual([{ note: "codex-b" }]);
  });

  it("confirms the save and reads the four Codex selects back on reopen (AP-TC-106)", async () => {
    const user = userEvent.setup();
    const saves: Record<string, Record<string, unknown>[]> = {};
    stubSave(saves);

    const { unmount } = render(<AgentConfigForm agent={codexAgent()} />);

    await pickOption(user, "model", "GPT-5.2 Codex");
    await pickOption(user, "effort", "Medium");
    await pickOption(user, "approvalPolicy", "On request");
    await pickOption(user, "sandbox", "Workspace write");
    await user.click(screen.getByTestId("agent-config-save-codex-cli"));

    // S001-O01: the save is confirmed in the form.
    expect(screen.getByText("Saved.")).toBeInTheDocument();
    expect(saves["codex-cli"]).toEqual([
      {
        model: "gpt-5.2-codex",
        effort: "medium",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
    ]);

    // S002-O01: reopening the form (a fresh mount over the persisted config, which
    // is what expanding the card again does) shows all four saved values, not the
    // schema defaults.
    unmount();
    render(<AgentConfigForm agent={codexAgent({ config: saves["codex-cli"][0] })} />);

    expect(selectedValue("model")).toBe("gpt-5.2-codex");
    expect(selectedValue("effort")).toBe("medium");
    expect(selectedValue("approvalPolicy")).toBe("on-request");
    expect(selectedValue("sandbox")).toBe("workspace-write");
    // ...and the user sees the saved choice, not the "Select an item" placeholder.
    expect(selectedLabel("model")).toBe("GPT-5.2 Codex");
    expect(selectedLabel("effort")).toBe("Medium");
    expect(selectedLabel("approvalPolicy")).toBe("On request");
    expect(selectedLabel("sandbox")).toBe("Workspace write");
    // Nothing is dirty on reopen: the rendered values ARE the saved ones.
    expect(screen.getByTestId("agent-config-save-codex-cli")).toBeDisabled();
  });
});
