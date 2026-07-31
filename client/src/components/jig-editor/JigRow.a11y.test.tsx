// @vitest-environment jsdom
//
// AP-TC-051 / AP-NFR-005: the per-jig agent binding select is reachable by Tab,
// carries a programmatic name that ties it to its own jig, is operable by
// keyboard alone, and the Custom jigs list scans clean.

import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { MemoryRouter } from "react-router-dom";
import type { AgentPluginState, JigMeta } from "@roubo/shared";
import JigRow, { DEFAULT_AGENT_VALUE } from "./JigRow";
import { expectNoAxeFindings } from "../../test/axe";

const AGENTS: AgentPluginState[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configSchema: { type: "object", properties: {} },
    config: {},
    unavailable: null,
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    configSchema: { type: "object", properties: {} },
    config: {},
    unavailable: null,
  },
];

function jig(id: string, name: string, overrides: Partial<JigMeta> = {}): JigMeta {
  return {
    id,
    name,
    description: `${name} description`,
    icon: "file-text",
    source: "app",
    ...overrides,
  } as JigMeta;
}

const REFACTOR = jig("refactor-pass", "Refactor pass");
const REVIEW = jig("review-pass", "Review pass");

function renderRows(jigs: JigMeta[] = [REFACTOR, REVIEW]) {
  const onAgentChange = vi.fn();
  const utils = render(
    <MemoryRouter>
      <div>
        {jigs.map((entry) => (
          <JigRow
            key={entry.id}
            jig={entry}
            editHref={`/jigs/edit/${entry.id}`}
            onDelete={vi.fn()}
            onDuplicate={vi.fn()}
            isDuplicating={false}
            agents={AGENTS}
            onAgentChange={onAgentChange}
          />
        ))}
      </div>
    </MemoryRouter>,
  );
  return { ...utils, onAgentChange };
}

describe("JigRow agent binding: accessibility (AP-TC-051)", () => {
  it("names each binding control after its own jig (S001-O01, S002-O01)", () => {
    renderRows();

    // Two rows, two distinct names: a screen-reader user can tell which jig a
    // binding belongs to without relying on visual proximity.
    expect(screen.getByRole("button", { name: /Agent for Refactor pass/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Agent for Review pass/ })).toBeDefined();
  });

  it("is reachable by Tab and operable by keyboard alone (S001-O01)", async () => {
    const user = userEvent.setup();
    const { onAgentChange } = renderRows([REFACTOR]);

    const trigger = screen.getByRole("button", { name: /Agent for Refactor pass/ });
    await user.tab();
    expect(document.activeElement).toBe(trigger);

    // Enter opens the listbox, arrow keys move through the options, Enter
    // commits: no pointer anywhere in the flow.
    await user.keyboard("{Enter}");
    const listbox = await screen.findByRole("listbox");
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Default agent", "Claude Code", "Codex CLI"]);

    await user.keyboard("{ArrowDown}{Enter}");

    expect(onAgentChange).toHaveBeenCalledWith(REFACTOR, "claude-code");
  });

  it("reports the default-agent sentinel as a null binding (S001-O01)", async () => {
    const user = userEvent.setup();
    const { onAgentChange } = renderRows([
      jig("bound", "Bound jig", { agentPluginId: "codex-cli" } as Partial<JigMeta>),
    ]);

    await user.tab();
    await user.keyboard("{Enter}");
    const listbox = await screen.findByRole("listbox");
    await user.click(within(listbox).getByRole("option", { name: "Default agent" }));

    expect(onAgentChange).toHaveBeenCalledWith(expect.objectContaining({ id: "bound" }), null);
  });

  it("has no axe violations across the Custom jigs list (S002-O01)", async () => {
    const { container } = renderRows();
    expectNoAxeFindings(await axe(container));
  });

  it("has no axe violations when a binding's agent is unavailable (S002-O01)", async () => {
    const { container } = renderRows([
      jig("orphan", "Orphan jig", { agentPluginId: "ghost-agent" } as Partial<JigMeta>),
    ]);

    expect(screen.getByRole("button", { name: /Agent for Orphan jig/ }).textContent).toContain(
      "ghost-agent (unavailable)",
    );
    expectNoAxeFindings(await axe(container));
  });

  it("keeps the sentinel exported for the binding's null value", () => {
    expect(DEFAULT_AGENT_VALUE).toBe("__default_agent__");
  });
});
