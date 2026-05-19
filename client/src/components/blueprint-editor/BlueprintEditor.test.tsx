// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { BlueprintDetail } from "@roubo/shared";
import { GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ blueprintId: mockBlueprintId }),
  };
});

let mockBlueprintId: string | undefined = undefined;
let mockQueryResult: {
  data: BlueprintDetail | undefined;
  isPending: boolean;
  error: Error | null;
} = {
  data: undefined,
  isPending: false,
  error: null,
};

vi.mock("../../hooks/useBlueprints", () => ({
  useGlobalBlueprint: () => mockQueryResult,
  useProjectBlueprint: () => ({
    data: undefined,
    isPending: false,
    error: null,
  }),
  useCreateGlobalBlueprint: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateGlobalBlueprint: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteGlobalBlueprint: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateProjectBlueprint: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateProjectBlueprint: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProjectBlueprint: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("./BlueprintEditorForm", () => ({
  default: ({ mode, initial }: { mode: string; initial?: BlueprintDetail }) => (
    <div data-testid="blueprint-editor-form" data-mode={mode} data-initial-name={initial?.name} />
  ),
}));

import BlueprintEditor from "./BlueprintEditor";

function renderEditor(mode: "create" | "edit", blueprintId?: string) {
  mockBlueprintId = blueprintId;
  return render(
    <MemoryRouter>
      <BlueprintEditor mode={mode} scope="global" />
    </MemoryRouter>,
  );
}

describe("BlueprintEditor", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockBlueprintId = undefined;
    mockQueryResult = { data: undefined, isPending: false, error: null };
  });

  it("renders form in create mode", () => {
    renderEditor("create");
    expect(screen.getByTestId("blueprint-editor-form")).toHaveAttribute("data-mode", "create");
  });

  it("shows loading state in edit mode while fetching", () => {
    mockQueryResult = { data: undefined, isPending: true, error: null };
    renderEditor("edit", "some-id");
    expect(screen.getByText(/Loading blueprint/i)).toBeInTheDocument();
  });

  it("shows error state in edit mode when fetch fails", () => {
    mockQueryResult = {
      data: undefined,
      isPending: false,
      error: new Error("Not found"),
    };
    renderEditor("edit", "some-id");
    expect(screen.getByText(/Blueprint not found/i)).toBeInTheDocument();
  });

  it("renders form in edit mode when data is loaded", () => {
    const detail: BlueprintDetail = {
      id: "my-bp",
      name: "My Blueprint",
      description: "A test blueprint",
      icon: "file-text",
      source: "app",
      content: "# Hello",
      sizeBytes: 100,
      approxTokens: 25,
    };
    mockQueryResult = { data: detail, isPending: false, error: null };
    renderEditor("edit", "my-bp");
    const form = screen.getByTestId("blueprint-editor-form");
    expect(form).toHaveAttribute("data-mode", "edit");
    expect(form).toHaveAttribute("data-initial-name", "My Blueprint");
  });

  it("shows read-only panel for the reserved built-in ID", () => {
    renderEditor("edit", GLOBAL_DEFAULT_BLUEPRINT_ID);
    expect(screen.getByText(/built-in default blueprint cannot be edited/i)).toBeInTheDocument();
    expect(screen.queryByTestId("blueprint-editor-form")).not.toBeInTheDocument();
  });

  it("navigates back from read-only panel", async () => {
    const user = userEvent.setup();
    renderEditor("edit", GLOBAL_DEFAULT_BLUEPRINT_ID);
    await user.click(screen.getByRole("button", { name: /Back to Settings/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/settings");
  });

  it("navigates back from error state", async () => {
    const user = userEvent.setup();
    mockQueryResult = {
      data: undefined,
      isPending: false,
      error: new Error("fail"),
    };
    renderEditor("edit", "bad-id");
    await user.click(screen.getByRole("button", { name: /Back to Settings/i }));
    expect(mockNavigate).toHaveBeenCalledWith("/settings");
  });
});
