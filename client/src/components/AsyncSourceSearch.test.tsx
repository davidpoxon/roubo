// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SourceCandidateItem } from "@roubo/shared";
import AsyncSourceSearch from "./AsyncSourceSearch";
import { useSourceOptions, type UseSourceOptionsResult } from "../hooks/useSourceOptions";

vi.mock("../hooks/useSourceOptions", () => ({
  useSourceOptions: vi.fn(),
}));

const mockUseSourceOptions = vi.mocked(useSourceOptions);

const fetchNextPage = vi.fn();

function mockHook(overrides: Partial<UseSourceOptionsResult> = {}) {
  mockUseSourceOptions.mockReturnValue({
    items: [],
    isLoading: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage,
    error: null,
    ...overrides,
  });
}

const BOARDS: SourceCandidateItem[] = [
  { externalId: "board:482", label: "PLAT Scrum Board", sublabel: "PLAT · board #482 · scrum" },
  { externalId: "board:99", label: "PLAT Kanban", sublabel: "PLAT · board #99 · kanban" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockHook();
});

describe("AsyncSourceSearch", () => {
  it("disables the search trigger and shows a hint when not enabled", () => {
    render(
      <AsyncSourceSearch
        projectId="p1"
        category="board"
        label="Boards"
        enabled={false}
        disabledHint="Pick a project first."
        value={[]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Add boards" })).toBeDisabled();
    expect(screen.getByText("Pick a project first.")).toBeInTheDocument();
  });

  it("renders untruncated results with a monospace key + id sublabel (FR-011)", async () => {
    const user = userEvent.setup();
    mockHook({ items: BOARDS });
    render(
      <AsyncSourceSearch
        projectId="p1"
        category="board"
        label="Boards"
        scope={{ project: ["PLAT"] }}
        value={[]}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add boards" }));
    const listbox = screen.getByRole("listbox", { name: "Boards results" });
    const name = within(listbox).getByText("PLAT Scrum Board");
    const sub = within(listbox).getByText("PLAT · board #482 · scrum");
    expect(name).toBeInTheDocument();
    // Secondary line is monospace; the full name is not clamped to ambiguity.
    expect(sub.className).toMatch(/font-mono/);
    expect(name.className).not.toMatch(/truncate/);
  });

  it("adds a picked result and surfaces the full item to the parent", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockHook({ items: BOARDS });
    render(
      <AsyncSourceSearch
        projectId="p1"
        category="board"
        label="Boards"
        scope={{ project: ["PLAT"] }}
        value={[]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add boards" }));
    await user.click(screen.getByRole("option", { name: /PLAT Scrum Board/ }));

    // A pick is delivered as a one-item add batch with no removals.
    expect(onChange).toHaveBeenCalledWith([BOARDS[0]], []);
  });

  it("renders selected entries as removable chips, resolving labels from results", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mockHook({ items: BOARDS });
    render(
      <AsyncSourceSearch
        projectId="p1"
        category="board"
        label="Boards"
        scope={{ project: ["PLAT"] }}
        value={[{ externalId: "board:482", project: "PLAT" }]}
        onChange={onChange}
      />,
    );

    // Open so the label cache fills from results, then close (the open popover
    // hides outside content for screen readers) and assert the chip shows the
    // friendly label rather than the raw externalId.
    await user.click(screen.getByRole("button", { name: "Add boards" }));
    await user.keyboard("{Escape}");
    const chips = screen.getByRole("list", { name: "Selected boards" });
    expect(within(chips).getByText("PLAT Scrum Board")).toBeInTheDocument();

    await user.click(within(chips).getByRole("button", { name: "Remove PLAT Scrum Board" }));
    // A chip removal is delivered as a one-id remove batch with no additions.
    expect(onChange).toHaveBeenCalledWith([], ["board:482"]);
  });

  it("shows a Load more control that pages the cursor", async () => {
    const user = userEvent.setup();
    mockHook({ items: BOARDS, hasNextPage: true });
    render(
      <AsyncSourceSearch
        projectId="p1"
        category="board"
        label="Boards"
        scope={{ project: ["PLAT"] }}
        value={[]}
        onChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Add boards" }));
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("is operable by keyboard: opens, exposes a labeled search field and results", async () => {
    const user = userEvent.setup();
    mockHook({ items: BOARDS });
    render(
      <AsyncSourceSearch
        projectId="p1"
        category="board"
        label="Boards"
        scope={{ project: ["PLAT"] }}
        value={[]}
        onChange={vi.fn()}
      />,
    );

    await user.tab();
    expect(screen.getByRole("button", { name: "Add boards" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("searchbox", { name: "Search boards" })).toBeInTheDocument();
    expect(screen.getByRole("listbox", { name: "Boards results" })).toBeInTheDocument();
  });
});
