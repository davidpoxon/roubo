// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { JigDetail } from "@roubo/shared";
import { GLOBAL_DEFAULT_JIG_ID } from "@roubo/shared";

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ jigId: mockJigId }),
  };
});

let mockJigId: string | undefined = undefined;
let mockQueryResult: {
  data: JigDetail | undefined;
  isPending: boolean;
  error: Error | null;
} = {
  data: undefined,
  isPending: false,
  error: null,
};

vi.mock("../../hooks/useJigs", () => ({
  useGlobalJig: () => mockQueryResult,
  useProjectJig: () => ({
    data: undefined,
    isPending: false,
    error: null,
  }),
  useCreateGlobalJig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateGlobalJig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteGlobalJig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateProjectJig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateProjectJig: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProjectJig: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("./JigEditorForm", () => ({
  default: ({ mode, initial }: { mode: string; initial?: JigDetail }) => (
    <div data-testid="jig-editor-form" data-mode={mode} data-initial-name={initial?.name} />
  ),
}));

import JigEditor from "./JigEditor";

function renderEditor(mode: "create" | "edit", jigId?: string) {
  mockJigId = jigId;
  return render(
    <MemoryRouter>
      <JigEditor mode={mode} scope="global" />
    </MemoryRouter>,
  );
}

describe("JigEditor", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockJigId = undefined;
    mockQueryResult = { data: undefined, isPending: false, error: null };
  });

  it("renders form in create mode", () => {
    renderEditor("create");
    expect(screen.getByTestId("jig-editor-form")).toHaveAttribute("data-mode", "create");
  });

  it("shows loading state in edit mode while fetching", () => {
    mockQueryResult = { data: undefined, isPending: true, error: null };
    renderEditor("edit", "some-id");
    expect(screen.getByText(/Loading jig/i)).toBeInTheDocument();
  });

  it("shows error state in edit mode when fetch fails", () => {
    mockQueryResult = {
      data: undefined,
      isPending: false,
      error: new Error("Not found"),
    };
    renderEditor("edit", "some-id");
    expect(screen.getByText(/Jig not found/i)).toBeInTheDocument();
  });

  it("renders form in edit mode when data is loaded", () => {
    const detail: JigDetail = {
      id: "my-bp",
      name: "My Jig",
      description: "A test jig",
      icon: "file-text",
      source: "app",
      content: "# Hello",
      sizeBytes: 100,
      approxTokens: 25,
    };
    mockQueryResult = { data: detail, isPending: false, error: null };
    renderEditor("edit", "my-bp");
    const form = screen.getByTestId("jig-editor-form");
    expect(form).toHaveAttribute("data-mode", "edit");
    expect(form).toHaveAttribute("data-initial-name", "My Jig");
  });

  it("shows read-only panel for the reserved built-in ID", () => {
    renderEditor("edit", GLOBAL_DEFAULT_JIG_ID);
    expect(screen.getByText(/built-in default jig cannot be edited/i)).toBeInTheDocument();
    expect(screen.queryByTestId("jig-editor-form")).not.toBeInTheDocument();
  });

  it("navigates back from read-only panel", async () => {
    const user = userEvent.setup();
    renderEditor("edit", GLOBAL_DEFAULT_JIG_ID);
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
