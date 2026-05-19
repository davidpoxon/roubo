// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CreateBenchModal from "./CreateBenchModal";

vi.mock("../hooks/useProjects");
vi.mock("../hooks/useBenches");
vi.mock("./Select", () => ({
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
      <option value="">{placeholder}</option>
      {items.map((item) => (
        <option key={item.value} value={item.value}>
          {item.label}
        </option>
      ))}
    </select>
  ),
}));

import { useProjects } from "../hooks/useProjects";
import { useCreateBench } from "../hooks/useBenches";

const mockUseProjects = vi.mocked(useProjects);
const mockUseCreateBench = vi.mocked(useCreateBench);

const validProject = {
  id: "proj-1",
  configValid: true,
  config: { project: { displayName: "My App", name: "my-app" } },
};

function makeCreateMock(overrides = {}) {
  return { mutate: vi.fn(), isPending: false, ...overrides } as unknown as ReturnType<
    typeof useCreateBench
  >;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUseProjects.mockReturnValue({ data: [validProject] } as unknown as ReturnType<
    typeof useProjects
  >);
  mockUseCreateBench.mockReturnValue(makeCreateMock());
});

describe("CreateBenchModal", () => {
  it("does not render when not open", () => {
    render(<CreateBenchModal isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("heading", { name: /set up bench/i })).not.toBeInTheDocument();
  });

  it("renders the dialog when open", () => {
    render(<CreateBenchModal isOpen onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /set up bench/i })).toBeInTheDocument();
  });

  it("shows project selector when no fixedProjectId", () => {
    render(<CreateBenchModal isOpen onClose={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: /select a project/i })).toBeInTheDocument();
  });

  it("hides project selector when fixedProjectId is provided", () => {
    render(<CreateBenchModal isOpen onClose={vi.fn()} projectId="proj-1" />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("shows validation error when submitting without a project", async () => {
    render(<CreateBenchModal isOpen onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /^set up$/i }));
    // Error paragraph — text-red-400
    const errors = screen.getAllByText("Select a project");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("calls createBench.mutate when form is submitted with fixedProjectId", async () => {
    const mutate = vi.fn();
    mockUseCreateBench.mockReturnValue(makeCreateMock({ mutate }));
    render(<CreateBenchModal isOpen onClose={vi.fn()} projectId="proj-1" />);
    await userEvent.click(screen.getByRole("button", { name: /set up/i }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1" }),
      expect.any(Object),
    );
  });

  it("shows server error when mutation fails", async () => {
    const mutate = vi.fn((_args, callbacks) => callbacks.onError(new Error("Branch exists")));
    mockUseCreateBench.mockReturnValue(makeCreateMock({ mutate }));
    render(<CreateBenchModal isOpen onClose={vi.fn()} projectId="proj-1" />);
    await userEvent.click(screen.getByRole("button", { name: /set up/i }));
    expect(screen.getByText("Branch exists")).toBeInTheDocument();
  });

  it('shows "Setting up..." when pending', () => {
    mockUseCreateBench.mockReturnValue(makeCreateMock({ isPending: true }));
    render(<CreateBenchModal isOpen onClose={vi.fn()} projectId="proj-1" />);
    expect(screen.getByRole("button", { name: /setting up/i })).toBeInTheDocument();
  });

  it("focuses the branch input when projectId is provided", () => {
    render(<CreateBenchModal isOpen onClose={vi.fn()} projectId="proj-1" />);
    expect(screen.getByPlaceholderText(/leave empty/i)).toHaveFocus();
  });

  it("does not focus the branch input when no projectId is provided", () => {
    render(<CreateBenchModal isOpen onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText(/leave empty/i)).not.toHaveFocus();
  });

  it("replaces spaces with hyphens in branch input", async () => {
    const mutate = vi.fn();
    mockUseCreateBench.mockReturnValue(makeCreateMock({ mutate }));
    render(<CreateBenchModal isOpen onClose={vi.fn()} projectId="proj-1" />);
    const branchInput = screen.getByPlaceholderText(/leave empty/i);
    await userEvent.type(branchInput, "my branch");
    // Spaces should have been converted to hyphens by keyDown handler
    await userEvent.click(screen.getByRole("button", { name: /set up/i }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ branch: expect.stringContaining("my") }),
      expect.any(Object),
    );
  });
});
