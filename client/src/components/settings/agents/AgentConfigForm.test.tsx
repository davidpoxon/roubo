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

function childOf<T extends Element>(container: HTMLElement, selector: string): T {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(`No ${selector} inside ${container.dataset.testid ?? "container"}`);
  return found;
}

async function pickModel(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(childOf<HTMLButtonElement>(screen.getByTestId("config-field-model"), "button"));
  await user.click(await screen.findByRole("option", { name: label }));
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
    expect(screen.getByTestId("config-field-model")).toHaveTextContent("opus");

    await user.click(screen.getByTestId("agent-config-reset-claude-code"));
    expect(screen.getByTestId("config-field-model")).toHaveTextContent("sonnet");
    expect(screen.getByTestId("agent-config-reset-claude-code")).toBeDisabled();
  });

  it("resets to the last SAVED values, not the values the form first mounted with", async () => {
    const user = userEvent.setup();
    render(<AgentConfigForm agent={agent({ config: { model: "sonnet" } })} />);

    await pickModel(user, "opus");
    await user.click(screen.getByTestId("agent-config-save-claude-code"));
    await pickModel(user, "sonnet");
    await user.click(screen.getByTestId("agent-config-reset-claude-code"));

    expect(screen.getByTestId("config-field-model")).toHaveTextContent("opus");
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
});
