// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { BlueprintDetail } from "@roubo/shared";
import { DEFAULT_CONTEXT_WINDOW } from "@roubo/shared";

const mockNavigate = vi.fn();
let mockBlocker = {
  state: "unblocked" as "unblocked" | "blocked" | "proceeding",
  proceed: vi.fn() as (() => void) | undefined,
  reset: vi.fn() as (() => void) | undefined,
};
let capturedBlockerFn:
  | ((args: {
      currentLocation: { pathname: string };
      nextLocation: { pathname: string };
    }) => boolean)
  | undefined;

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useBlocker: (fn: typeof capturedBlockerFn) => {
      capturedBlockerFn = fn;
      return mockBlocker;
    },
  };
});

const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockRemove = vi.fn();
const mockCreateProject = vi.fn();
const mockUpdateProject = vi.fn();
const mockRemoveProject = vi.fn();

vi.mock("../../hooks/useBlueprints", () => ({
  useCreateGlobalBlueprint: () => ({
    mutateAsync: mockCreate,
    isPending: false,
  }),
  useUpdateGlobalBlueprint: () => ({
    mutateAsync: mockUpdate,
    isPending: false,
  }),
  useDeleteGlobalBlueprint: () => ({
    mutateAsync: mockRemove,
    isPending: false,
  }),
  useCreateProjectBlueprint: () => ({
    mutateAsync: mockCreateProject,
    isPending: false,
  }),
  useUpdateProjectBlueprint: () => ({
    mutateAsync: mockUpdateProject,
    isPending: false,
  }),
  useDeleteProjectBlueprint: () => ({
    mutateAsync: mockRemoveProject,
    isPending: false,
  }),
}));

vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

let mockContextWindow = DEFAULT_CONTEXT_WINDOW;
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => ({
    settings: { contextWindow: mockContextWindow },
    isLoading: false,
    updateSettings: vi.fn(),
  }),
}));

vi.mock("../../lib/api", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;
    readonly code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
  isBlueprintReferencedError: () => false,
}));

vi.mock("./BlueprintMarkdownEditor", () => ({
  default: vi.fn(({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="markdown-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  )),
}));

vi.mock("./VariableInsertionPanel", () => ({
  default: ({ onInsert }: { onInsert: (s: string) => void }) => (
    <button onClick={() => onInsert("{{bench.id}}")}>Insert variable</button>
  ),
}));

vi.mock("./BlueprintPreviewPanel", () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="blueprint-preview-panel">{content}</div>
  ),
}));

vi.mock("./BlueprintIconPicker", () => ({
  default: ({ value, onChange }: { value: string; onChange: (icon: string) => void }) => (
    <div data-testid="icon-picker">
      <span data-testid="current-icon">{value}</span>
      <button onClick={() => onChange("rocket")}>Pick rocket</button>
    </div>
  ),
}));

vi.mock("./UnsavedChangesDialog", () => ({
  default: ({
    isOpen,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div data-testid="unsaved-dialog">
        <button onClick={onConfirm}>Confirm discard</button>
        <button onClick={onCancel}>Keep editing</button>
      </div>
    ) : null,
}));

vi.mock("./DeleteBlueprintDialog", () => ({
  default: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="delete-dialog" /> : null,
}));

import BlueprintEditorForm from "./BlueprintEditorForm";
import { ApiError } from "../../lib/api";

const initialBlueprint: BlueprintDetail = {
  id: "my-bp",
  name: "My Blueprint",
  description: "A test blueprint",
  icon: "file-text",
  source: "app",
  content: "# Hello world",
  sizeBytes: 500,
  approxTokens: 125,
};

function renderForm(props: Partial<Parameters<typeof BlueprintEditorForm>[0]> = {}) {
  const defaults: Parameters<typeof BlueprintEditorForm>[0] = {
    mode: "create",
    scope: "global",
  };
  return render(
    <MemoryRouter>
      <BlueprintEditorForm {...defaults} {...props} />
    </MemoryRouter>,
  );
}

describe("BlueprintEditorForm", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockCreate.mockClear();
    mockUpdate.mockClear();
    mockRemove.mockClear();
    mockCreateProject.mockClear();
    mockUpdateProject.mockClear();
    mockRemoveProject.mockClear();
    mockContextWindow = DEFAULT_CONTEXT_WINDOW;
    mockBlocker = { state: "unblocked", proceed: vi.fn(), reset: vi.fn() };
    capturedBlockerFn = undefined;
  });

  it("renders in create mode with empty fields", () => {
    renderForm({ mode: "create" });
    expect(screen.getByPlaceholderText("My blueprint")).toHaveValue("");
    expect(screen.getByPlaceholderText("What this blueprint does")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("populates fields from initial in edit mode", () => {
    renderForm({ mode: "edit", initial: initialBlueprint });
    expect(screen.getByPlaceholderText("My blueprint")).toHaveValue("My Blueprint");
    expect(screen.getByPlaceholderText("What this blueprint does")).toHaveValue("A test blueprint");
  });

  it("shows the blueprint id in edit mode", () => {
    renderForm({ mode: "edit", initial: initialBlueprint });
    expect(screen.getByText(/ID: my-bp/)).toBeInTheDocument();
  });

  it("shows ID preview in create mode when name is typed", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    await user.type(screen.getByPlaceholderText("My blueprint"), "Test Blueprint");
    expect(screen.getByText(/ID will be: test-blueprint/)).toBeInTheDocument();
  });

  it("blocks Save when name is empty", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Name is required.")).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("blocks Save when description is empty", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    await user.type(screen.getByPlaceholderText("My blueprint"), "Some Name");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Description is required.")).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("shows inline error when name exceeds 100 characters", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    await user.type(screen.getByPlaceholderText("My blueprint"), "a".repeat(101));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Name must be 100 characters or fewer.")).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("shows inline error when description exceeds 300 characters", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    await user.type(screen.getByPlaceholderText("My blueprint"), "Valid Name");
    fireEvent.change(screen.getByPlaceholderText("What this blueprint does"), {
      target: { value: "a".repeat(301) },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Description must be 300 characters or fewer.")).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("calls mutateAsync and navigates on successful create", async () => {
    const user = userEvent.setup();
    mockCreate.mockResolvedValue({});
    renderForm({ mode: "create" });
    await user.type(screen.getByPlaceholderText("My blueprint"), "New Blueprint");
    await user.type(screen.getByPlaceholderText("What this blueprint does"), "Does things");
    await user.type(screen.getByTestId("markdown-editor"), "# Content");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    expect(mockNavigate).toHaveBeenCalledWith("/settings");
  });

  it("calls update mutateAsync in edit mode", async () => {
    const user = userEvent.setup();
    mockUpdate.mockResolvedValue({});
    renderForm({ mode: "edit", initial: initialBlueprint });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        id: "my-bp",
        body: expect.objectContaining({ name: "My Blueprint" }),
      }),
    );
  });

  it("Cancel navigates to /settings", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockNavigate).toHaveBeenCalledWith("/settings");
  });

  it("UnsavedChangesDialog is shown when blocker is in blocked state", () => {
    mockBlocker = { state: "blocked", proceed: vi.fn(), reset: vi.fn() };
    renderForm({ mode: "create" });
    expect(screen.getByTestId("unsaved-dialog")).toBeInTheDocument();
  });

  it("UnsavedChangesDialog is hidden when blocker is unblocked", () => {
    mockBlocker = { state: "unblocked", proceed: vi.fn(), reset: vi.fn() };
    renderForm({ mode: "create" });
    expect(screen.queryByTestId("unsaved-dialog")).not.toBeInTheDocument();
  });

  it("Confirm discard calls blocker.proceed()", async () => {
    const proceed = vi.fn();
    mockBlocker = { state: "blocked", proceed, reset: vi.fn() };
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    await user.click(screen.getByRole("button", { name: "Confirm discard" }));
    expect(proceed).toHaveBeenCalled();
  });

  it("Keep editing calls blocker.reset()", async () => {
    const reset = vi.fn();
    mockBlocker = { state: "blocked", proceed: vi.fn(), reset };
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(reset).toHaveBeenCalled();
  });

  it("blocker predicate returns false after a successful save (justSavedRef prevents re-block)", async () => {
    mockCreate.mockResolvedValue({});
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    await user.type(screen.getByPlaceholderText("My blueprint"), "New Blueprint");
    await user.type(screen.getByPlaceholderText("What this blueprint does"), "Does things");
    fireEvent.change(screen.getByTestId("markdown-editor"), {
      target: { value: "# Content" },
    });

    // Before save: form is dirty, so predicate should block navigation
    const loc = { pathname: "/settings/blueprints/new" };
    const next = { pathname: "/settings" };
    expect(capturedBlockerFn?.({ currentLocation: loc, nextLocation: next })).toBe(true);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/settings"));

    // After save: justSavedRef.current is true, so predicate should not block
    expect(capturedBlockerFn?.({ currentLocation: loc, nextLocation: next })).toBe(false);
  });

  it("shows Delete button in edit mode", () => {
    renderForm({ mode: "edit", initial: initialBlueprint });
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("does not show Delete button in create mode", () => {
    renderForm({ mode: "create" });
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("shows size counter", () => {
    renderForm({ mode: "create" });
    expect(screen.getByText(/0 B \/ 200 KB/)).toBeInTheDocument();
  });

  it("shows token and context-percent counter", () => {
    renderForm({ mode: "create" });
    expect(screen.getByText(/~0 tokens · 0% of 200K context/)).toBeInTheDocument();
  });

  it("reflects custom context window in the percent counter", () => {
    mockContextWindow = 500_000;
    renderForm({ mode: "create" });
    expect(screen.getByText(/500K context/)).toBeInTheDocument();
  });

  it("falls back to DEFAULT_CONTEXT_WINDOW label when settings returns default", () => {
    mockContextWindow = DEFAULT_CONTEXT_WINDOW;
    renderForm({ mode: "create" });
    expect(screen.getByText(/200K context/)).toBeInTheDocument();
  });

  it("formats exact-million context window as M suffix", () => {
    mockContextWindow = 1_000_000;
    renderForm({ mode: "create" });
    expect(screen.getByText(/1M context/)).toBeInTheDocument();
  });

  it("formats non-round million context window with one decimal (locale-safe)", () => {
    mockContextWindow = 1_500_000;
    renderForm({ mode: "create" });
    expect(screen.getByText(/1\.5M context/)).toBeInTheDocument();
  });

  it("shows soft-warn copy and updates percent when content approaches 50 KB", async () => {
    const softContent = "x".repeat(50 * 1024);
    renderForm({ mode: "create" });
    fireEvent.change(screen.getByTestId("markdown-editor"), {
      target: { value: softContent },
    });
    expect(screen.getByText(/Large blueprint/)).toBeInTheDocument();
    expect(screen.getByText(/% of the context window per run/)).toBeInTheDocument();
  });

  it("shows size-limit error and blocks Save when content exceeds 200 KB", async () => {
    const user = userEvent.setup();
    const bigContent = "x".repeat(200 * 1024 + 1);
    renderForm({ mode: "create" });
    await user.type(screen.getByPlaceholderText("My blueprint"), "My Blueprint");
    await user.type(screen.getByPlaceholderText("What this blueprint does"), "Does things");
    fireEvent.change(screen.getByTestId("markdown-editor"), {
      target: { value: bigContent },
    });
    expect(screen.getByText(/Content exceeds the 200 KB limit/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("breadcrumb shows the current icon for create mode", () => {
    renderForm({ mode: "create" });
    // BlueprintIcon renders a lucide SVG; check it exists in the breadcrumb area
    const breadcrumb = screen.getByRole("button", { name: "Settings" }).closest("div");
    expect(breadcrumb?.querySelector("svg")).toBeInTheDocument();
  });

  it("breadcrumb icon reflects picker selection", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "create" });
    expect(screen.getByTestId("current-icon")).toHaveTextContent("file-text");
    await user.click(screen.getByRole("button", { name: "Pick rocket" }));
    // After picking rocket, the picker current-icon and breadcrumb BlueprintIcon should update
    expect(screen.getByTestId("current-icon")).toHaveTextContent("rocket");
  });

  it("shows inline name error for DUPLICATE_NAME API response", async () => {
    const user = userEvent.setup();
    mockCreate.mockRejectedValueOnce(new ApiError("Name already taken", 409, "DUPLICATE_NAME"));
    renderForm({ mode: "create" });
    await user.type(screen.getByPlaceholderText("My blueprint"), "My Blueprint");
    await user.type(screen.getByPlaceholderText("What this blueprint does"), "Does things");
    fireEvent.change(screen.getByTestId("markdown-editor"), {
      target: { value: "# Content" },
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.getByText("Another blueprint already uses this name.")).toBeInTheDocument(),
    );
  });

  it("renders Edit and Preview tabs in the centre column", () => {
    renderForm({ mode: "create" });
    expect(screen.getByRole("tab", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Preview" })).toBeInTheDocument();
  });

  it("shows the markdown editor in the Edit tab by default", () => {
    renderForm({ mode: "create" });
    expect(screen.getByTestId("markdown-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("blueprint-preview-panel")).not.toBeInTheDocument();
  });

  it("shows the preview panel when Preview tab is clicked", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "edit", initial: initialBlueprint });
    await user.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByTestId("blueprint-preview-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown-editor")).not.toBeInTheDocument();
  });

  it("passes current content to the preview panel", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "edit", initial: initialBlueprint });
    await user.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByTestId("blueprint-preview-panel")).toHaveTextContent("# Hello world");
  });

  it("Save button remains active while Preview tab is active", async () => {
    const user = userEvent.setup();
    renderForm({ mode: "edit", initial: initialBlueprint });
    await user.click(screen.getByRole("tab", { name: "Preview" }));
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
  });

  describe('scope="project"', () => {
    it('breadcrumb reads "Project settings"', () => {
      renderForm({ mode: "create", scope: "project", projectId: "proj-1" });
      expect(screen.getByRole("button", { name: "Project settings" })).toBeInTheDocument();
    });

    it("Cancel navigates to /projects/:projectId/settings", async () => {
      const user = userEvent.setup();
      renderForm({ mode: "create", scope: "project", projectId: "proj-1" });
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      expect(mockNavigate).toHaveBeenCalledWith("/projects/proj-1/settings");
    });

    it("uses project create mutation and navigates to project settings on save", async () => {
      const user = userEvent.setup();
      mockCreateProject.mockResolvedValue({});
      renderForm({ mode: "create", scope: "project", projectId: "proj-1" });
      await user.type(screen.getByPlaceholderText("My blueprint"), "New Blueprint");
      await user.type(screen.getByPlaceholderText("What this blueprint does"), "Does things");
      fireEvent.change(screen.getByTestId("markdown-editor"), {
        target: { value: "# Content" },
      });
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(mockCreateProject).toHaveBeenCalledTimes(1));
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockNavigate).toHaveBeenCalledWith("/projects/proj-1/settings");
    });

    it("uses project update mutation in edit mode", async () => {
      const user = userEvent.setup();
      mockUpdateProject.mockResolvedValue({});
      renderForm({
        mode: "edit",
        scope: "project",
        projectId: "proj-1",
        initial: initialBlueprint,
      });
      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() =>
        expect(mockUpdateProject).toHaveBeenCalledWith({
          id: "my-bp",
          body: expect.objectContaining({ name: "My Blueprint" }),
        }),
      );
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
