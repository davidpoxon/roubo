// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/renderWithProviders";
import { PermissionsRulesTable } from "./PermissionsRulesTable";
import type { PermissionRule, SelectionState } from "./permissionsTable";

function renderTable(
  rules: PermissionRule[] = [],
  editable = false,
  onRemove = vi.fn(),
  onEdit = vi.fn(),
) {
  return renderWithProviders(
    <PermissionsRulesTable rules={rules} editable={editable} onRemove={onRemove} onEdit={onEdit} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PermissionsRulesTable", () => {
  it("renders the empty state message when no rules", () => {
    renderTable();
    expect(screen.getByText("No permissions saved.")).toBeInTheDocument();
  });

  it("renders a custom empty state message", () => {
    renderWithProviders(<PermissionsRulesTable rules={[]} emptyMessage="Nothing here yet." />);
    expect(screen.getByText("Nothing here yet.")).toBeInTheDocument();
  });

  it("renders allow rules with correct badge", () => {
    renderTable([{ type: "allow", pattern: "Bash(npm test:*)" }]);
    expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
    expect(screen.getByText("allow")).toBeInTheDocument();
  });

  it("renders deny rules with correct badge", () => {
    renderTable([{ type: "deny", pattern: "Bash(rm:*)" }]);
    expect(screen.getByText("Bash(rm:*)")).toBeInTheDocument();
    expect(screen.getByText("deny")).toBeInTheDocument();
  });

  it("renders ask rules with correct badge", () => {
    renderTable([{ type: "ask", pattern: "Edit(.env*)" }]);
    expect(screen.getByText("Edit(.env*)")).toBeInTheDocument();
    expect(screen.getByText("ask")).toBeInTheDocument();
  });

  it("renders Rule and Pattern column headers when editable", () => {
    renderTable([{ type: "allow", pattern: "Bash(npm:*)" }], true);
    expect(screen.getByText("Rule")).toBeInTheDocument();
    expect(screen.getByText("Pattern")).toBeInTheDocument();
    expect(screen.getByText("Actions")).toBeInTheDocument();
  });

  it("does not render Actions column header when not editable", () => {
    renderTable([{ type: "allow", pattern: "Bash(npm:*)" }], false);
    expect(screen.queryByText("Actions")).not.toBeInTheDocument();
  });

  it("calls onRemove with the correct index when Remove is clicked", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    renderTable(
      [
        { type: "allow", pattern: "Bash(npm test:*)" },
        { type: "deny", pattern: "Bash(rm:*)" },
      ],
      true,
      onRemove,
    );
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    await user.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith(0);
  });

  it("entering edit mode shows Save and Cancel buttons", async () => {
    const user = userEvent.setup();
    renderTable([{ type: "allow", pattern: "Bash(npm test:*)" }], true);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("calls onEdit with updated rule when Save is clicked", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderTable([{ type: "allow", pattern: "Bash(npm test:*)" }], true, vi.fn(), onEdit);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Bash(npm run lint:*)");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onEdit).toHaveBeenCalledWith(0, {
      type: "allow",
      pattern: "Bash(npm run lint:*)",
    });
  });

  it("Cancel returns to display mode without calling onEdit", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderTable([{ type: "allow", pattern: "Bash(npm test:*)" }], true, vi.fn(), onEdit);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
  });

  it("pressing Enter in the edit input saves the edit", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderTable([{ type: "allow", pattern: "Bash(npm test:*)" }], true, vi.fn(), onEdit);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Read(src/**)");
    await user.keyboard("{Enter}");
    expect(onEdit).toHaveBeenCalledWith(0, {
      type: "allow",
      pattern: "Read(src/**)",
    });
  });

  it("pressing Escape in the edit input cancels without calling onEdit", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderTable([{ type: "allow", pattern: "Bash(npm test:*)" }], true, vi.fn(), onEdit);
    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    await user.keyboard("{Escape}");
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
  });

  it("shows 'Rule already exists' error and does not call onEdit for a duplicate edit", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderTable(
      [
        { type: "allow", pattern: "Bash(*)" },
        { type: "allow", pattern: "Read(**/*.ts)" },
      ],
      true,
      vi.fn(),
      onEdit,
    );
    const editButtons = screen.getAllByRole("button", { name: /^edit$/i });
    await user.click(editButtons[1]);
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Bash(*)");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText("Rule already exists")).toBeInTheDocument();
  });

  describe("pagination", () => {
    function makeRules(n: number): PermissionRule[] {
      return Array.from({ length: n }, (_, i) => ({
        type: "allow" as const,
        pattern: `Rule${i}`,
      }));
    }

    it("does not show pagination controls when rules.length <= pageSize", () => {
      renderWithProviders(<PermissionsRulesTable rules={makeRules(5)} pageSize={10} />);
      expect(screen.queryByRole("button", { name: /previous page/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /next page/i })).not.toBeInTheDocument();
    });

    it("shows pagination controls when rules.length > pageSize", () => {
      renderWithProviders(<PermissionsRulesTable rules={makeRules(15)} pageSize={10} />);
      expect(screen.getByRole("button", { name: /previous page/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /next page/i })).toBeInTheDocument();
    });

    it("shows only the first page of rules initially", () => {
      renderWithProviders(<PermissionsRulesTable rules={makeRules(15)} pageSize={10} />);
      expect(screen.getByText("Rule0")).toBeInTheDocument();
      expect(screen.getByText("Rule9")).toBeInTheDocument();
      expect(screen.queryByText("Rule10")).not.toBeInTheDocument();
    });

    it("navigates to the next page when Next is clicked", async () => {
      const user = userEvent.setup();
      renderWithProviders(<PermissionsRulesTable rules={makeRules(15)} pageSize={10} />);
      await user.click(screen.getByRole("button", { name: /next page/i }));
      expect(screen.queryByText("Rule0")).not.toBeInTheDocument();
      expect(screen.getByText("Rule10")).toBeInTheDocument();
      expect(screen.getByText("Rule14")).toBeInTheDocument();
    });

    it("navigates back to the previous page when Prev is clicked", async () => {
      const user = userEvent.setup();
      renderWithProviders(<PermissionsRulesTable rules={makeRules(15)} pageSize={10} />);
      await user.click(screen.getByRole("button", { name: /next page/i }));
      await user.click(screen.getByRole("button", { name: /previous page/i }));
      expect(screen.getByText("Rule0")).toBeInTheDocument();
      expect(screen.queryByText("Rule10")).not.toBeInTheDocument();
    });

    it("suppresses pagination when paginate={false}", () => {
      renderWithProviders(
        <PermissionsRulesTable rules={makeRules(15)} pageSize={10} paginate={false} />,
      );
      expect(screen.queryByRole("button", { name: /previous page/i })).not.toBeInTheDocument();
      expect(screen.getByText("Rule14")).toBeInTheDocument();
    });
  });

  describe("type filter", () => {
    const mixedRules: PermissionRule[] = [
      { type: "allow", pattern: "Bash(npm:*)" },
      { type: "allow", pattern: "Read(**)" },
      { type: "deny", pattern: "Bash(rm:*)" },
      { type: "ask", pattern: "Edit(.env*)" },
    ];

    it("shows filter pills with correct counts", () => {
      renderWithProviders(<PermissionsRulesTable rules={mixedRules} />);
      expect(screen.getByRole("button", { name: /^All \(4\)$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^allow \(2\)$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^deny \(1\)$/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^ask \(1\)$/i })).toBeInTheDocument();
    });

    it("filters to only allow rules when allow pill is clicked", async () => {
      const user = userEvent.setup();
      renderWithProviders(<PermissionsRulesTable rules={mixedRules} />);
      await user.click(screen.getByRole("button", { name: /^allow \(2\)$/i }));
      expect(screen.getByText("Bash(npm:*)")).toBeInTheDocument();
      expect(screen.getByText("Read(**)")).toBeInTheDocument();
      expect(screen.queryByText("Bash(rm:*)")).not.toBeInTheDocument();
      expect(screen.queryByText("Edit(.env*)")).not.toBeInTheDocument();
    });

    it("shows 'No rules match this filter.' when the filtered type has zero results", async () => {
      const user = userEvent.setup();
      renderWithProviders(
        <PermissionsRulesTable rules={[{ type: "allow", pattern: "Bash(*)" }]} />,
      );
      await user.click(screen.getByRole("button", { name: /^deny \(0\)$/i }));
      expect(screen.getByText("No rules match this filter.")).toBeInTheDocument();
    });

    it("resets to page 1 when filter changes", async () => {
      const user = userEvent.setup();
      const lotsOfAllows: PermissionRule[] = Array.from({ length: 12 }, (_, i) => ({
        type: "allow" as const,
        pattern: `Allow${i}`,
      }));
      const oneAsk: PermissionRule = { type: "ask", pattern: "Edit(.env*)" };
      renderWithProviders(
        <PermissionsRulesTable rules={[...lotsOfAllows, oneAsk]} pageSize={10} />,
      );
      await user.click(screen.getByRole("button", { name: /next page/i }));
      expect(screen.queryByText("Allow0")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /^allow \(12\)/i }));
      expect(screen.getByText("Allow0")).toBeInTheDocument();
    });

    it("suppresses footer when showTypeFilter={false} and no pagination needed", () => {
      renderWithProviders(
        <PermissionsRulesTable rules={mixedRules} showTypeFilter={false} pageSize={100} />,
      );
      expect(screen.queryByRole("button", { name: /^All/i })).not.toBeInTheDocument();
    });
  });

  describe("selection mode", () => {
    const rules: PermissionRule[] = [
      { type: "allow", pattern: "Bash(npm test:*)" },
      { type: "deny", pattern: "Bash(rm:*)" },
    ];

    function makeSelection(overrides: Partial<SelectionState> = {}): SelectionState {
      return {
        selectedKeys: new Set<string>(),
        onToggleKey: vi.fn(),
        ...overrides,
      };
    }

    it("renders checkboxes for each row when selection is provided", () => {
      renderWithProviders(<PermissionsRulesTable rules={rules} selection={makeSelection()} />);
      expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    });

    it("does not render checkboxes without selection prop", () => {
      renderWithProviders(<PermissionsRulesTable rules={rules} />);
      expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    });

    it("reflects selectedKeys in checkbox checked state", () => {
      const selection = makeSelection({
        selectedKeys: new Set(["allow:Bash(npm test:*)"]),
      });
      renderWithProviders(<PermissionsRulesTable rules={rules} selection={selection} />);
      const checkboxes = screen.getAllByRole("checkbox");
      expect(checkboxes[0]).toBeChecked();
      expect(checkboxes[1]).not.toBeChecked();
    });

    it("calls onToggleKey with the correct key when a row is clicked", async () => {
      const onToggleKey = vi.fn();
      const user = userEvent.setup();
      renderWithProviders(
        <PermissionsRulesTable rules={rules} selection={makeSelection({ onToggleKey })} />,
      );
      const checkboxes = screen.getAllByRole("checkbox");
      await user.click(checkboxes[1]);
      expect(onToggleKey).toHaveBeenCalledWith("deny:Bash(rm:*)");
    });

    it("still renders rule patterns in selection mode", () => {
      renderWithProviders(<PermissionsRulesTable rules={rules} selection={makeSelection()} />);
      expect(screen.getByText("Bash(npm test:*)")).toBeInTheDocument();
      expect(screen.getByText("Bash(rm:*)")).toBeInTheDocument();
    });
  });

  describe("highlight mode", () => {
    const rules: PermissionRule[] = [
      { type: "allow", pattern: "Bash(*)" },
      { type: "allow", pattern: "Read(**)" },
      { type: "deny", pattern: "Bash(rm:*)" },
    ];

    it("renders + glyph for highlighted rows", () => {
      const highlightKeys = new Set(["allow:Read(**)", "deny:Bash(rm:*)"]);
      renderWithProviders(<PermissionsRulesTable rules={rules} highlightKeys={highlightKeys} />);
      const plusGlyphs = screen.getAllByText("+");
      expect(plusGlyphs).toHaveLength(2);
    });

    it("does not render + glyph for non-highlighted rows", () => {
      const highlightKeys = new Set(["allow:Read(**)"] as string[]);
      renderWithProviders(<PermissionsRulesTable rules={rules} highlightKeys={highlightKeys} />);
      expect(screen.getAllByText("+")).toHaveLength(1);
    });

    it("renders no + glyphs when highlightKeys is empty", () => {
      renderWithProviders(<PermissionsRulesTable rules={rules} highlightKeys={new Set()} />);
      expect(screen.queryByText("+")).not.toBeInTheDocument();
    });

    it("renders no + glyphs when highlightKeys is not provided", () => {
      renderWithProviders(<PermissionsRulesTable rules={rules} />);
      expect(screen.queryByText("+")).not.toBeInTheDocument();
    });
  });
});
