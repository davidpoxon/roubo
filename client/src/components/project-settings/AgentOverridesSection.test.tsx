// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectAgentState } from "@roubo/shared";
import { ApiError } from "../../lib/api";

vi.mock("../../hooks/useProjectAgents");

import {
  useProjectAgents as _useProjectAgents,
  useSaveProjectAgentOverride as _useSave,
} from "../../hooks/useProjectAgents";
import { AgentOverridesSection } from "./AgentOverridesSection";
import { PROBE_LOADING_TEXT, probeFailureCopy } from "../probe-state-copy";

const mockedList = vi.mocked(_useProjectAgents);
const mockedSave = vi.mocked(_useSave);

/** AP-TC-005 / AP-TC-010 / AP-TC-016 preconditions: model/effort/mode. */
const CLAUDE: ProjectAgentState = {
  id: "claude-code",
  name: "Claude Code",
  version: "1.2.0",
  configSchema: {
    type: "object",
    properties: {
      model: { type: "string", title: "Model", enum: ["sonnet", "opus", "haiku"] },
      effort: { type: "string", title: "Effort", enum: ["low", "high"] },
      mode: { type: "string", title: "Mode", enum: ["plan", "auto"] },
    },
  },
  appDefaults: { model: "opus", effort: "high", mode: "plan" },
  overrides: {},
  effective: { model: "opus", effort: "high", mode: "plan" },
  unavailable: null,
  misconfigured: null,
};

/**
 * #1045: an integer-typed field, the shape whose input emits `undefined` when
 * cleared. Kept separate from CLAUDE so the effective-preview assertions above
 * keep reading exactly `model=..., effort=..., mode=...`.
 */
const GEMINI: ProjectAgentState = {
  id: "gemini-cli",
  name: "Gemini CLI",
  configSchema: {
    type: "object",
    properties: { maxTurns: { type: "integer", title: "Max turns" } },
  },
  appDefaults: { maxTurns: 12 },
  overrides: {},
  effective: { maxTurns: 12 },
  unavailable: null,
  misconfigured: null,
};

function listResult(agents: ProjectAgentState[], orphanedOverrides: unknown[] = []) {
  return {
    data: { agents, orphanedOverrides },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useProjectAgents>;
}

const mutate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockedSave.mockReturnValue({ mutate, isPending: false } as unknown as ReturnType<
    typeof _useSave
  >);
});

describe("AgentOverridesSection", () => {
  it("shows every field's app default beside its override row (AP-TC-005 S001)", () => {
    mockedList.mockReturnValue(listResult([CLAUDE]));
    render(<AgentOverridesSection projectId="demo" />);

    const card = within(screen.getByTestId("project-agent-card-claude-code"));
    expect(card.getByTestId("project-agent-toggle-claude-code-model")).toBeInTheDocument();
    expect(card.getByTestId("project-agent-app-default-claude-code-model")).toHaveTextContent(
      "App default: opus",
    );
    expect(card.getByTestId("project-agent-app-default-claude-code-effort")).toHaveTextContent(
      "App default: high",
    );
    expect(card.getByTestId("project-agent-app-default-claude-code-mode")).toHaveTextContent(
      "App default: plan",
    );
  });

  it("marks the un-overridden fields as inheriting (AP-TC-005 S002)", async () => {
    mockedList.mockReturnValue(listResult([{ ...CLAUDE, overrides: { model: "sonnet" } }]));
    render(<AgentOverridesSection projectId="demo" />);

    expect(
      screen.queryByTestId("project-agent-inherits-claude-code-model"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("project-agent-inherits-claude-code-effort")).toHaveTextContent(
      "Inherits app default",
    );
    expect(screen.getByTestId("project-agent-inherits-claude-code-mode")).toHaveTextContent(
      "Inherits app default",
    );
  });

  it("previews the effective config as app defaults overlaid per field (AP-TC-005 S003)", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CLAUDE,
          overrides: { model: "sonnet" },
          effective: { model: "sonnet", effort: "high", mode: "plan" },
        },
      ]),
    );
    render(<AgentOverridesSection projectId="demo" />);

    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=sonnet, effort=high, mode=plan",
    );
  });

  it("reverts a field to the app default when its override is toggled off (AP-TC-005 S004)", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([{ ...CLAUDE, overrides: { model: "sonnet" } }]));
    render(<AgentOverridesSection projectId="demo" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Model" }));

    expect(screen.getByTestId("project-agent-inherits-claude-code-model")).toBeInTheDocument();
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=opus, effort=high, mode=plan",
    );
  });

  it("saves the override subset, not a whole config", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([CLAUDE]));
    render(<AgentOverridesSection projectId="demo" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Model" }));
    await user.click(screen.getByTestId("project-agent-save-claude-code"));

    expect(mutate).toHaveBeenCalledTimes(1);
    // Toggling a field on seeds it with the app default it replaces, and no
    // other field joins the payload.
    expect(mutate.mock.calls[0][0]).toEqual({ model: "opus" });
  });

  it("banners a save rejection that names a field this project inherits", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([CLAUDE]));
    render(<AgentOverridesSection projectId="demo" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Model" }));
    await user.click(screen.getByTestId("project-agent-save-claude-code"));

    // The server validates the MERGED config, so a rejection can name a field
    // the project does not override. That field renders no control, so the
    // error has nowhere to hang and must reach the form-level banner rather
    // than being silently dropped.
    await act(async () => {
      mutate.mock.calls[0][1].onError(
        new ApiError("Invalid agent configuration", 400, undefined, {
          fieldErrors: [{ path: "effort", message: "must be one of: low, high" }],
        }),
      );
    });

    expect(screen.getByTestId("project-agent-error-claude-code")).toHaveTextContent(
      "must be one of: low, high",
    );
  });

  it("attaches a save rejection to the overridden field it names", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([CLAUDE]));
    render(<AgentOverridesSection projectId="demo" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Model" }));
    await user.click(screen.getByTestId("project-agent-save-claude-code"));

    await act(async () => {
      mutate.mock.calls[0][1].onError(
        new ApiError("Invalid agent configuration", 400, undefined, {
          fieldErrors: [{ path: "model", message: "must be one of: sonnet, opus, haiku" }],
        }),
      );
    });

    // The overridden field renders a control, so the error hangs off it and
    // the form-level banner stays out of the way.
    expect(screen.queryByTestId("project-agent-error-claude-code")).not.toBeInTheDocument();
    expect(screen.getByText("must be one of: sonnet, opus, haiku")).toBeInTheDocument();
  });

  it("previews the fully-overridden and fully-inherited boundaries exactly (AP-TC-010)", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CLAUDE,
          overrides: { model: "sonnet", effort: "low", mode: "auto" },
          effective: { model: "sonnet", effort: "low", mode: "auto" },
        },
      ]),
    );
    const { unmount } = render(<AgentOverridesSection projectId="demo" />);
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=sonnet, effort=low, mode=auto",
    );
    unmount();

    mockedList.mockReturnValue(listResult([CLAUDE]));
    render(<AgentOverridesSection projectId="demo" />);
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=opus, effort=high, mode=plan",
    );
  });

  it("tracks an app-default change on the fields that inherit (AP-TC-010 S003)", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CLAUDE,
          appDefaults: { model: "haiku", effort: "high", mode: "plan" },
          effective: { model: "haiku", effort: "high", mode: "plan" },
        },
      ]),
    );
    render(<AgentOverridesSection projectId="demo" />);

    expect(screen.getByTestId("project-agent-app-default-claude-code-model")).toHaveTextContent(
      "App default: haiku",
    );
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=haiku",
    );
  });

  it("holds an overridden field fixed while an inherited one tracks (AP-TC-016 S002)", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CLAUDE,
          appDefaults: { model: "opus", effort: "low", mode: "plan" },
          overrides: { model: "sonnet" },
          effective: { model: "sonnet", effort: "low", mode: "plan" },
        },
      ]),
    );
    render(<AgentOverridesSection projectId="demo" />);

    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=sonnet, effort=low, mode=plan",
    );
  });

  it("keeps a cleared numeric override defined and escapable (#1045)", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([GEMINI]));
    render(<AgentOverridesSection projectId="demo" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Max turns" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Max turns" }));

    // Clearing a number input emits `undefined`. Storing that would leave the
    // row claiming an override with no value: the preview would read "not set"
    // while the wire payload dropped the key, and with the draft matching the
    // saved state both Save and Reset would disable, stranding the user.
    expect(
      screen.queryByTestId("project-agent-inherits-gemini-cli-maxTurns"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("project-agent-effective-gemini-cli")).toHaveTextContent(
      "maxTurns=12",
    );
    expect(screen.getByTestId("project-agent-save-gemini-cli")).not.toBeDisabled();
    expect(screen.getByTestId("project-agent-reset-gemini-cli")).not.toBeDisabled();
    // The box itself stays empty: the draft holds the value, the input holds
    // the user's in-progress edit, so clearing remains an ordinary edit step.
    expect(screen.getByRole("spinbutton", { name: "Max turns" })).toHaveValue(null);
  });

  it("replaces, rather than appends to, a cleared numeric override (#1045)", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([GEMINI]));
    render(<AgentOverridesSection projectId="demo" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Max turns" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Max turns" }));
    await user.type(screen.getByRole("spinbutton", { name: "Max turns" }), "5");

    // Re-injecting the fallback into the controlled input would make the
    // keystroke land after the old value and save 125.
    expect(screen.getByRole("spinbutton", { name: "Max turns" })).toHaveValue(5);
    expect(screen.getByTestId("project-agent-effective-gemini-cli")).toHaveTextContent(
      "maxTurns=5",
    );

    await user.click(screen.getByTestId("project-agent-save-gemini-cli"));
    expect(mutate.mock.calls[0][0]).toEqual({ maxTurns: 5 });
  });

  it("saves the seeded fallback when a cleared numeric override is left empty (#1045)", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([GEMINI]));
    render(<AgentOverridesSection projectId="demo" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Max turns" }));
    await user.clear(screen.getByRole("spinbutton", { name: "Max turns" }));
    await user.click(screen.getByTestId("project-agent-save-gemini-cli"));

    // An empty box is an in-progress edit, not an absent value: the override
    // saves the defined fallback rather than dropping the key.
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({ maxTurns: 12 });
  });

  it("leaves Reset live to repopulate an emptied box on a clean draft (#1045)", async () => {
    const user = userEvent.setup();
    // The saved override already equals the app default, so emptying the box
    // changes nothing in the draft and `dirty` stays false.
    mockedList.mockReturnValue(listResult([{ ...GEMINI, overrides: { maxTurns: 12 } }]));
    render(<AgentOverridesSection projectId="demo" />);

    await user.clear(screen.getByRole("spinbutton", { name: "Max turns" }));

    expect(screen.getByRole("spinbutton", { name: "Max turns" })).toHaveValue(null);
    expect(screen.getByTestId("project-agent-save-gemini-cli")).toBeDisabled();
    expect(screen.getByTestId("project-agent-reset-gemini-cli")).not.toBeDisabled();

    await user.click(screen.getByTestId("project-agent-reset-gemini-cli"));

    expect(screen.getByRole("spinbutton", { name: "Max turns" })).toHaveValue(12);
  });

  it("names an orphaned override without rendering a card for it (AP-TC-008)", () => {
    mockedList.mockReturnValue(
      listResult([CLAUDE], [{ pluginId: "ghost-agent", reason: "not-installed" }]),
    );
    render(<AgentOverridesSection projectId="demo" />);

    expect(screen.getByTestId("project-agent-orphaned-overrides")).toHaveTextContent("ghost-agent");
    expect(screen.queryByTestId("project-agent-card-ghost-agent")).not.toBeInTheDocument();
    // The installed plugin's effective config is unaffected.
    expect(screen.getByTestId("project-agent-effective-claude-code")).toHaveTextContent(
      "model=opus, effort=high, mode=plan",
    );
  });

  it("renders an empty state, not an error, with no agent plugins installed", () => {
    mockedList.mockReturnValue(listResult([]));
    render(<AgentOverridesSection projectId="demo" />);

    expect(screen.getByTestId("project-agents-empty-state")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces a load failure as an alert", () => {
    mockedList.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("boom"),
    } as unknown as ReturnType<typeof _useProjectAgents>);
    render(<AgentOverridesSection projectId="demo" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load agent overrides: boom");
  });

  it("gives each installed plugin its own independent card", () => {
    const codex: ProjectAgentState = {
      id: "codex-cli",
      name: "Codex CLI",
      configSchema: {
        type: "object",
        properties: { sandbox: { type: "string", title: "Sandbox", enum: ["read-only", "write"] } },
      },
      appDefaults: { sandbox: "read-only" },
      overrides: {},
      effective: { sandbox: "read-only" },
      unavailable: null,
      misconfigured: null,
    };
    mockedList.mockReturnValue(listResult([CLAUDE, codex]));
    render(<AgentOverridesSection projectId="demo" />);

    const claude = within(screen.getByTestId("project-agent-card-claude-code"));
    expect(claude.getByText("Model")).toBeInTheDocument();
    expect(claude.queryByText("Sandbox")).not.toBeInTheDocument();

    const codexCard = within(screen.getByTestId("project-agent-card-codex-cli"));
    expect(codexCard.getByText("Sandbox")).toBeInTheDocument();
    expect(codexCard.queryByText("Model")).not.toBeInTheDocument();
  });
});

// #1365: the project agents response serves the same `choiceProbes` map as the
// AI Agents screen's, and an overridden probe-bound field reads it the same way:
// an empty choice control with a loading line, or the failure's cause and
// remedy, never the manifest's plain free-text property (APCC-FR-003,
// APCC-TC-016, APCC-TC-024).
describe("AgentOverridesSection: choice-probe states (#1365)", () => {
  /** Cursor's shape: a plain-string `model` whose choices only the probe supplies. */
  const CURSOR: ProjectAgentState = {
    id: "cursor-cli",
    name: "Cursor CLI",
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string", title: "Model" },
        mode: { type: "string", title: "Mode", enum: ["plan", "ask"] },
      },
    },
    appDefaults: {},
    overrides: { model: "gpt-5" },
    effective: { model: "gpt-5" },
    unavailable: null,
    misconfigured: null,
    choiceProbes: { model: { state: "loading" } },
  };

  const FAILED = {
    state: "failed",
    cause: "command-not-found",
    reason: "agent not on PATH",
  } as const;

  it("shows an overridden field's loading probe as the AI Agents screen does", () => {
    mockedList.mockReturnValue(listResult([CURSOR]));
    render(<AgentOverridesSection projectId="demo" />);

    const row = within(screen.getByTestId("project-agent-field-cursor-cli-model"));
    expect(row.getByTestId("config-field-model")).toHaveAttribute("data-probe-state", "loading");
    expect(row.getByTestId("config-field-model-probe-status")).toHaveTextContent(
      PROBE_LOADING_TEXT,
    );
    expect(row.queryByRole("textbox")).toBeNull();
    // The probe binds `model` only; the other row is untouched.
    expect(screen.queryByTestId("config-field-mode-probe-status")).toBeNull();
  });

  it("shows an overridden field's failed probe with its cause and remedy", () => {
    mockedList.mockReturnValue(listResult([{ ...CURSOR, choiceProbes: { model: FAILED } }]));
    render(<AgentOverridesSection projectId="demo" />);

    const copy = probeFailureCopy(FAILED.cause, FAILED.reason);
    const row = within(screen.getByTestId("project-agent-field-cursor-cli-model"));
    expect(row.getByTestId("config-field-model")).toHaveAttribute("data-probe-state", "failed");
    const status = row.getByTestId("config-field-model-probe-status");
    expect(status).toHaveTextContent(copy.cause);
    expect(status).toHaveTextContent(copy.remedy);
    expect(row.queryByRole("textbox")).toBeNull();
  });

  it("announces the failure through the status region the loading line used (APCC-TC-022)", () => {
    mockedList.mockReturnValue(listResult([CURSOR]));
    const { rerender } = render(<AgentOverridesSection projectId="demo" />);
    const loading = screen.getByTestId("config-field-model-probe-status");
    expect(loading).toHaveAttribute("role", "status");

    // The bounded poll in `useProjectAgents` delivers the failure on the same
    // open; the card must re-read it rather than keep its first render.
    mockedList.mockReturnValue(listResult([{ ...CURSOR, choiceProbes: { model: FAILED } }]));
    rerender(<AgentOverridesSection projectId="demo" />);

    const failed = screen.getByTestId("config-field-model-probe-status");
    expect(failed).toBe(loading);
    expect(failed).toHaveTextContent(probeFailureCopy(FAILED.cause, FAILED.reason).cause);
  });

  it("renders a resolved probe's choices through the ordinary select", () => {
    mockedList.mockReturnValue(
      listResult([
        {
          ...CURSOR,
          configSchema: {
            type: "object",
            properties: {
              model: {
                type: "string",
                title: "Model",
                oneOf: [{ const: "gpt-5", title: "GPT-5" }],
              },
            },
          },
          choiceProbes: { model: { state: "resolved" } },
        },
      ]),
    );
    render(<AgentOverridesSection projectId="demo" />);

    expect(screen.queryByTestId("config-field-model-probe-status")).toBeNull();
    expect(screen.getByTestId("config-field-model")).not.toHaveAttribute("data-probe-state");
  });

  it("will not start an override it could only seed with an empty value while the probe is pending", () => {
    mockedList.mockReturnValue(
      listResult([
        { ...CURSOR, overrides: {}, effective: {} },
        {
          ...CURSOR,
          id: "cursor-failed",
          name: "Cursor failed",
          overrides: {},
          effective: {},
          choiceProbes: { model: FAILED },
        },
      ]),
    );
    render(<AgentOverridesSection projectId="demo" />);

    // Nothing to seed the row with and no choices to pick from, so turning it
    // on could only store `model: ""`. The row says why it is locked.
    const loadingToggle = screen.getByTestId("project-agent-toggle-cursor-cli-model");
    expect(within(loadingToggle).getByRole("checkbox")).toBeDisabled();
    const loadingHint = screen.getByTestId("project-agent-inherits-cursor-cli-model");
    expect(loadingHint).toHaveTextContent("Inherits app default");
    expect(loadingHint).toHaveTextContent("once its choices are read");
    expect(within(loadingToggle).getByRole("checkbox")).toHaveAttribute(
      "aria-describedby",
      loadingHint.id,
    );

    const failedToggle = screen.getByTestId("project-agent-toggle-cursor-failed-model");
    expect(within(failedToggle).getByRole("checkbox")).toBeDisabled();
    expect(screen.getByTestId("project-agent-inherits-cursor-failed-model")).toHaveTextContent(
      "could not be read",
    );

    // A field the probe does not bind stays freely overridable.
    const modeToggle = screen.getByTestId("project-agent-toggle-cursor-cli-mode");
    expect(within(modeToggle).getByRole("checkbox")).not.toBeDisabled();
  });

  it("releases the lock once the probe resolves, seeding the first probed choice", async () => {
    const user = userEvent.setup();
    const locked = { ...CURSOR, overrides: {}, effective: {} };
    mockedList.mockReturnValue(listResult([locked]));
    const { rerender } = render(<AgentOverridesSection projectId="demo" />);
    expect(screen.getByRole("checkbox", { name: "Override Model" })).toBeDisabled();

    mockedList.mockReturnValue(
      listResult([
        {
          ...locked,
          configSchema: {
            type: "object",
            properties: {
              model: {
                type: "string",
                title: "Model",
                oneOf: [
                  { const: "gpt-5", title: "GPT-5" },
                  { const: "sonnet-4", title: "Sonnet 4" },
                ],
              },
            },
          },
          choiceProbes: { model: { state: "resolved" } },
        },
      ]),
    );
    rerender(<AgentOverridesSection projectId="demo" />);

    const toggle = screen.getByRole("checkbox", { name: "Override Model" });
    expect(toggle).not.toBeDisabled();
    await user.click(toggle);
    await user.click(screen.getByTestId("project-agent-save-cursor-cli"));
    expect(mutate.mock.calls[0][0]).toEqual({ model: "gpt-5" });
  });

  it("still starts an override the app default can seed while the probe is pending", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(
      listResult([
        {
          ...CURSOR,
          appDefaults: { model: "gpt-5" },
          overrides: {},
          effective: { model: "gpt-5" },
        },
      ]),
    );
    render(<AgentOverridesSection projectId="demo" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Model" }));

    expect(screen.getByTestId("config-field-model")).toHaveAttribute("data-probe-state", "loading");
    await user.click(screen.getByTestId("project-agent-save-cursor-cli"));
    expect(mutate.mock.calls[0][0]).toEqual({ model: "gpt-5" });
  });

  it("lets an already-overridden field go back to inheriting while the probe is pending", async () => {
    const user = userEvent.setup();
    mockedList.mockReturnValue(listResult([CURSOR]));
    render(<AgentOverridesSection projectId="demo" />);

    await user.click(screen.getByRole("checkbox", { name: "Override Model" }));

    expect(screen.getByTestId("project-agent-inherits-cursor-cli-model")).toBeInTheDocument();
    await user.click(screen.getByTestId("project-agent-save-cursor-cli"));
    expect(mutate.mock.calls[0][0]).toEqual({});
  });
});
