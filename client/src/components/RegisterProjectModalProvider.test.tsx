// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RegisterProjectModalProvider } from "./RegisterProjectModalProvider";
import { useRegisterProjectModal } from "../hooks/useRegisterProjectModal";
import { Button } from "react-aria-components";

vi.mock("./RegisterProjectModal", () => {
  function MockModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
    const [value, setValue] = useState("");
    if (!isOpen) return null;
    return (
      <div data-testid="register-modal">
        <input
          data-testid="directory-picker"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button onClick={onClose}>Cancel</button>
      </div>
    );
  }
  return { default: MockModal };
});

vi.mock("../hooks/useProjects", () => ({
  useCheckConfig: vi.fn(() => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
  })),
  useRegisterProject: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

function TriggerButton() {
  const { open } = useRegisterProjectModal();
  return <Button onPress={open}>Open modal</Button>;
}

function renderWithProvider() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RegisterProjectModalProvider>
          <TriggerButton />
        </RegisterProjectModalProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("RegisterProjectModalProvider", () => {
  it("does not show modal initially", () => {
    renderWithProvider();
    expect(screen.queryByTestId("register-modal")).not.toBeInTheDocument();
  });

  it("shows modal when open() is called", async () => {
    renderWithProvider();
    const user = userEvent.setup();
    await user.click(screen.getByText("Open modal"));
    expect(screen.getByTestId("register-modal")).toBeInTheDocument();
  });

  it("throws when useRegisterProjectModal used outside provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <MemoryRouter>
          <TriggerButton />
        </MemoryRouter>,
      ),
    ).toThrow("useRegisterProjectModal must be used within RegisterProjectModalProvider");
    spy.mockRestore();
  });

  it("resets modal state when opened a second time", async () => {
    renderWithProvider();
    const user = userEvent.setup();

    // Open modal and type a value
    await user.click(screen.getByText("Open modal"));
    await user.type(screen.getByTestId("directory-picker"), "/home/user/repo");
    expect(screen.getByTestId("directory-picker")).toHaveValue("/home/user/repo");

    // Close the modal (simulates cancel)
    await user.click(screen.getByText("Cancel"));
    expect(screen.queryByTestId("register-modal")).not.toBeInTheDocument();

    // Open modal again: key change forces remount, so state resets
    await user.click(screen.getByText("Open modal"));
    expect(screen.getByTestId("directory-picker")).toHaveValue("");
  });
});
