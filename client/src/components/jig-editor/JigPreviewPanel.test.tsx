// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@codemirror/view", () => ({
  EditorView: class {
    static lineWrapping = {};
    static editable = { of: () => ({}) };
    static contentAttributes = { of: () => ({}) };
    constructor({ parent }: { parent?: Element }) {
      if (parent) parent.innerHTML = '<div class="cm-editor" />';
    }
    dispatch() {}
    get state() {
      return { doc: { toString: () => "" } };
    }
    destroy() {}
  },
  ViewPlugin: { fromClass: () => ({}) },
  Decoration: { mark: () => ({}) },
  keymap: { of: () => ({}) },
}));

vi.mock("@codemirror/state", () => ({
  EditorState: { create: () => ({}) },
  Compartment: class {
    of() {
      return {};
    }
    reconfigure() {
      return {};
    }
  },
  RangeSetBuilder: class {
    add() {}
    finish() {
      return {};
    }
  },
}));

vi.mock("@codemirror/lang-markdown", () => ({ markdown: () => ({}) }));

vi.mock("./codemirrorTheme", () => ({
  lightTheme: [],
  darkTheme: [],
  variableHighlightPlugin: {},
}));

vi.mock("../Select", () => ({
  default: ({
    items,
    value,
    onChange,
    placeholder,
  }: {
    items: { value: string; label: string }[];
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
  }) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={placeholder ?? "select"}
    >
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
}));

const mockUseJigPreview = vi.fn();
const mockUseProjectBenches = vi.fn();
const mockUseProjects = vi.fn();

vi.mock("../../hooks/useJigs", () => ({
  useJigPreview: (...args: unknown[]) => mockUseJigPreview(...args),
}));

vi.mock("../../hooks/useBenches", () => ({
  useProjectBenches: (...args: unknown[]) => mockUseProjectBenches(...args),
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: (...args: unknown[]) => mockUseProjects(...args),
}));

import JigPreviewPanel from "./JigPreviewPanel";

function renderPanel(props: Partial<Parameters<typeof JigPreviewPanel>[0]> = {}) {
  const defaults: Parameters<typeof JigPreviewPanel>[0] = {
    content: "# Hello {{bench.branch}}",
    scope: "global",
  };
  return render(<JigPreviewPanel {...defaults} {...props} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseProjectBenches.mockReturnValue({ data: [] });
  mockUseProjects.mockReturnValue({ data: [] });
});

describe("JigPreviewPanel", () => {
  it('shows "Start typing" placeholder when preview data is absent and content is empty', () => {
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderPanel({ content: "" });
    expect(screen.getByText("Start typing to see a preview.")).toBeInTheDocument();
  });

  it("shows loading state while preview is pending", () => {
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: true, isError: false });
    renderPanel({ content: "# Hello" });
    expect(screen.getByText("Generating preview…")).toBeInTheDocument();
  });

  it("shows error state when preview fails", () => {
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: false, isError: true });
    renderPanel({ content: "# Hello" });
    expect(screen.getByText("Failed to generate preview.")).toBeInTheDocument();
  });

  it("renders resolved preview in the CodeMirror viewer", () => {
    mockUseJigPreview.mockReturnValue({
      data: { resolved: "# Hello feature/my-change", unresolvedVariables: [] },
      isPending: false,
      isError: false,
    });
    renderPanel();
    expect(screen.getByTestId("jig-readonly-viewer")).toBeInTheDocument();
  });

  it("shows unresolved variables banner when variables remain", () => {
    mockUseJigPreview.mockReturnValue({
      data: { resolved: "port is {{ports.server}}", unresolvedVariables: ["{{ports.server}}"] },
      isPending: false,
      isError: false,
    });
    renderPanel();
    expect(screen.getByTestId("unresolved-variables-banner")).toBeInTheDocument();
    expect(screen.getByText(/\{\{ports\.server\}\}/)).toBeInTheDocument();
  });

  it("hides the unresolved banner when all variables are resolved", () => {
    mockUseJigPreview.mockReturnValue({
      data: { resolved: "# Hello feature/my-change", unresolvedVariables: [] },
      isPending: false,
      isError: false,
    });
    renderPanel();
    expect(screen.queryByTestId("unresolved-variables-banner")).not.toBeInTheDocument();
  });

  it('shows up to 3 unresolved variables and a "+N more" suffix', () => {
    mockUseJigPreview.mockReturnValue({
      data: {
        resolved: "{{a}} {{b}} {{c}} {{d}}",
        unresolvedVariables: ["{{a}}", "{{b}}", "{{c}}", "{{d}}"],
      },
      isPending: false,
      isError: false,
    });
    renderPanel();
    expect(screen.getByText(/\+1 more/)).toBeInTheDocument();
  });

  it('renders bench picker with "Sample values" default option', () => {
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderPanel();
    const select = screen.getByRole("combobox", { name: /context source/i });
    expect(select).toHaveValue("sample");
    expect(screen.getByRole("option", { name: "Sample values" })).toBeInTheDocument();
  });

  it("shows available benches in the picker", () => {
    mockUseProjectBenches.mockReturnValue({
      data: [
        {
          id: 1,
          projectId: "proj-1",
          branch: "feature/foo",
          status: "active",
          ports: {},
          components: {},
          createdAt: "",
          provisioningSteps: [],
          teardownSteps: [],
          notifications: [],
        },
        {
          id: 2,
          projectId: "proj-1",
          branch: "issue-42",
          status: "active",
          ports: {},
          components: {},
          createdAt: "",
          provisioningSteps: [],
          teardownSteps: [],
          notifications: [],
          assignedIssue: { number: 42, title: "Fix bug" },
        },
      ],
    });
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderPanel({ scope: "project", projectId: "proj-1" });
    expect(screen.getByRole("option", { name: /Bench 1: feature\/foo/ })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Bench 2: issue-42 · #42 Fix bug/ }),
    ).toBeInTheDocument();
  });

  it("prefixes bench label with project display name in global scope", () => {
    mockUseProjects.mockReturnValue({
      data: [
        {
          id: "proj-1",
          config: { project: { displayName: "My App" } },
          configValid: true,
          settings: {},
        },
      ],
    });
    mockUseProjectBenches.mockReturnValue({
      data: [
        {
          id: 1,
          projectId: "proj-1",
          branch: "feature/foo",
          status: "active",
          ports: {},
          components: {},
          createdAt: "",
          provisioningSteps: [],
          teardownSteps: [],
          notifications: [],
        },
      ],
    });
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderPanel({ scope: "global" });
    expect(
      screen.getByRole("option", { name: /My App — Bench 1: feature\/foo/ }),
    ).toBeInTheDocument();
  });

  it("passes projectId and benchId to useJigPreview when bench is selected", async () => {
    const user = userEvent.setup();
    mockUseProjectBenches.mockReturnValue({
      data: [
        {
          id: 1,
          projectId: "proj-1",
          branch: "feature/foo",
          status: "active",
          ports: {},
          components: {},
          createdAt: "",
          provisioningSteps: [],
          teardownSteps: [],
          notifications: [],
        },
      ],
    });
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderPanel({ scope: "project", projectId: "proj-1" });

    const select = screen.getByRole("combobox", { name: /context source/i });
    await user.selectOptions(select, "bench:proj-1:1");

    expect(mockUseJigPreview).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", benchId: 1 }),
    );
  });

  it("passes undefined projectId/benchId to useJigPreview for sample values", () => {
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderPanel();
    expect(mockUseJigPreview).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined, benchId: undefined }),
    );
  });

  it("passes project-scoped projectId to useProjectBenches for project scope", () => {
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderPanel({ scope: "project", projectId: "proj-abc" });
    expect(mockUseProjectBenches).toHaveBeenCalledWith("proj-abc");
  });

  it("passes undefined to useProjectBenches for global scope", () => {
    mockUseJigPreview.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderPanel({ scope: "global" });
    expect(mockUseProjectBenches).toHaveBeenCalledWith(undefined);
  });
});
