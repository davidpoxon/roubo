// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RegisterProjectTile from "./RegisterProjectTile";
import { RegisterProjectModalProvider } from "./RegisterProjectModalProvider";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("./RegisterProjectModal", () => ({
  default: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="register-modal">Modal</div> : null,
}));

vi.mock("../hooks/useProjects", () => ({
  useCheckConfig: vi.fn(() => ({ data: undefined, isLoading: false, isFetching: false })),
  useRegisterProject: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

function renderTile() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RegisterProjectModalProvider>
          <RegisterProjectTile />
        </RegisterProjectModalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RegisterProjectTile", () => {
  it("renders Register project label and helper text", () => {
    renderTile();
    expect(screen.getByText("Register project")).toBeInTheDocument();
    expect(screen.getByText(/Point Roubo at a repo with/)).toBeInTheDocument();
  });

  it("opens register modal when tile is pressed", async () => {
    renderTile();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));
    expect(screen.getByTestId("register-modal")).toBeInTheDocument();
  });
});
