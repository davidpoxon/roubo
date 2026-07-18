// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AssignContainerModal from "./AssignContainerModal";

vi.mock("../hooks/useContainers", () => ({
  useContainers: vi.fn(),
  useAssignContainer: vi.fn(),
}));
import { useContainers, useAssignContainer } from "../hooks/useContainers";

const mockUseContainers = vi.mocked(useContainers);
const mockUseAssignContainer = vi.mocked(useAssignContainer);

function makeAssignMock(overrides = {}) {
  return {
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    ...overrides,
  } as unknown as ReturnType<typeof useAssignContainer>;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUseAssignContainer.mockReturnValue(makeAssignMock());
});

describe("AssignContainerModal", () => {
  it("shows loading state while containers are loading", () => {
    mockUseContainers.mockReturnValue({ data: undefined, isLoading: true } as unknown as ReturnType<
      typeof useContainers
    >);
    render(
      <AssignContainerModal
        projectId="p1"
        benchId={1}
        component="db"
        isOpen
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/loading containers/i)).toBeInTheDocument();
  });

  it("shows empty state when no running containers", () => {
    mockUseContainers.mockReturnValue({ data: [], isLoading: false } as unknown as ReturnType<
      typeof useContainers
    >);
    render(
      <AssignContainerModal
        projectId="p1"
        benchId={1}
        component="db"
        isOpen
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/no running database containers/i)).toBeInTheDocument();
  });

  it("shows only running containers", () => {
    mockUseContainers.mockReturnValue({
      data: [
        { id: "c1", name: "postgres", image: "postgres:16", status: "running", port: 5432 },
        { id: "c2", name: "mysql", image: "mysql:8", status: "stopped", port: 3306 },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useContainers>);
    render(
      <AssignContainerModal
        projectId="p1"
        benchId={1}
        component="db"
        isOpen
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText("postgres")).toBeInTheDocument();
    expect(screen.queryByText("mysql")).not.toBeInTheDocument();
  });

  it("enables the assign button after selecting a container", async () => {
    mockUseContainers.mockReturnValue({
      data: [{ id: "c1", name: "postgres", image: "postgres:16", status: "running", port: 5432 }],
      isLoading: false,
    } as unknown as ReturnType<typeof useContainers>);
    render(
      <AssignContainerModal
        projectId="p1"
        benchId={1}
        component="db"
        isOpen
        onOpenChange={vi.fn()}
      />,
    );

    const assignBtn = screen.getByRole("button", { name: /^assign$/i });
    expect(assignBtn).toBeDisabled();

    await userEvent.click(screen.getByText("postgres"));
    expect(assignBtn).not.toBeDisabled();
  });

  it("calls mutateAsync when assign button is pressed", async () => {
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    mockUseAssignContainer.mockReturnValue(makeAssignMock({ mutateAsync }));
    mockUseContainers.mockReturnValue({
      data: [{ id: "c1", name: "postgres", image: "postgres:16", status: "running", port: 5432 }],
      isLoading: false,
    } as unknown as ReturnType<typeof useContainers>);
    render(
      <AssignContainerModal
        projectId="p1"
        benchId={1}
        component="db"
        isOpen
        onOpenChange={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByText("postgres"));
    await userEvent.click(screen.getByRole("button", { name: /^assign$/i }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        projectId: "p1",
        benchId: 1,
        containerId: "c1",
        component: "db",
      }),
    );
  });

  it("shows the component name in the description", () => {
    mockUseContainers.mockReturnValue({ data: [], isLoading: false } as unknown as ReturnType<
      typeof useContainers
    >);
    render(
      <AssignContainerModal
        projectId="p1"
        benchId={1}
        component="my-database"
        isOpen
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByText("my-database")).toBeInTheDocument();
  });

  it("does not render when not open", () => {
    mockUseContainers.mockReturnValue({ data: [], isLoading: false } as unknown as ReturnType<
      typeof useContainers
    >);
    render(
      <AssignContainerModal
        projectId="p1"
        benchId={1}
        component="db"
        isOpen={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/assign container/i)).not.toBeInTheDocument();
  });

  // Issue #612 / #424: React Aria omits aria-modal and strips the prop, so the
  // shared stampAriaModal ref is what makes the modality explicit to AT.
  it("stamps aria-modal on the dialog", () => {
    mockUseContainers.mockReturnValue({ data: [], isLoading: false } as unknown as ReturnType<
      typeof useContainers
    >);
    render(
      <AssignContainerModal
        projectId="p1"
        benchId={1}
        component="db"
        isOpen
        onOpenChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });
});
