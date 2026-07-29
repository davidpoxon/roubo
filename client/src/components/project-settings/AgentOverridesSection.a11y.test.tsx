// @vitest-environment jsdom
//
// AP-NFR-004: zero serious axe violations on the project Agent overrides
// section, across its three states (populated with a mix of overridden and
// inherited fields, the orphaned-override notice, and the no-plugins empty
// state).

import { describe, it, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import type { ProjectAgentState } from "@roubo/shared";
import { expectNoAxeFindings } from "../../test/axe";

vi.mock("../../hooks/useProjectAgents");

import {
  useProjectAgents as _useProjectAgents,
  useSaveProjectAgentOverride as _useSave,
} from "../../hooks/useProjectAgents";
import { AgentOverridesSection } from "./AgentOverridesSection";

const mockedList = vi.mocked(_useProjectAgents);
const mockedSave = vi.mocked(_useSave);

const AGENTS: ProjectAgentState[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    version: "1.2.0",
    description: "Terminal coding agent.",
    configSchema: {
      type: "object",
      properties: {
        model: { type: "string", title: "Model", enum: ["sonnet", "opus"] },
        maxTurns: { type: "integer", title: "Max turns" },
        verbose: { type: "boolean", title: "Verbose" },
        note: { type: "string", title: "Note" },
      },
    },
    appDefaults: { model: "opus", maxTurns: 20, verbose: false, note: "" },
    overrides: { model: "sonnet", verbose: true },
    effective: { model: "sonnet", maxTurns: 20, verbose: true, note: "" },
    unavailable: null,
    misconfigured: null,
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    version: "0.9.0",
    configSchema: {
      type: "object",
      properties: { sandbox: { type: "string", title: "Sandbox", enum: ["read-only", "write"] } },
    },
    appDefaults: {},
    overrides: {},
    effective: {},
    unavailable: { reason: "not-consented", message: "Acknowledge its permissions first." },
    misconfigured: null,
  },
];

function listResult(agents: ProjectAgentState[], orphanedOverrides: unknown[] = []) {
  return {
    data: { agents, orphanedOverrides },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useProjectAgents>;
}

beforeEach(() => {
  mockedSave.mockReturnValue({ mutate: vi.fn(), isPending: false } as unknown as ReturnType<
    typeof _useSave
  >);
});

describe("AgentOverridesSection: axe-core", () => {
  it("has no axe violations with overridden and inherited fields", async () => {
    mockedList.mockReturnValue(listResult(AGENTS));
    const { container } = render(<AgentOverridesSection projectId="roubo-development" />);
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations with an orphaned override notice", async () => {
    mockedList.mockReturnValue(
      listResult(AGENTS, [{ pluginId: "ghost-agent", reason: "not-installed" }]),
    );
    const { container } = render(<AgentOverridesSection projectId="roubo-development" />);
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations in the no-plugins empty state", async () => {
    mockedList.mockReturnValue(listResult([]));
    const { container } = render(<AgentOverridesSection projectId="roubo-development" />);
    expectNoAxeFindings(await axe(container));
  });
});
