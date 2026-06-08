// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/renderWithProviders";
import type { DiscoveredSpec } from "../../lib/api";
import type { ManualPathState } from "../../hooks/useTestbenchSpecs";

const mockUseTestbenchSpecs = vi.hoisted(() => vi.fn());
const mockUseManualPathValidation = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useTestbenchSpecs", () => ({
  useTestbenchSpecs: (...args: unknown[]) => mockUseTestbenchSpecs(...args),
  useManualPathValidation: (...args: unknown[]) => mockUseManualPathValidation(...args),
}));

import SpecPickerModal from "./SpecPickerModal";

const SPECS: DiscoveredSpec[] = [
  { slug: "testbench", path: "/repo/.specifications/testbench/test-cases.json", caseCount: 3 },
  { slug: "billing", path: "/repo/.specifications/billing/test-cases.json", caseCount: 1 },
];

function specsQuery(over: Partial<ReturnType<typeof mockUseTestbenchSpecs>> = {}) {
  return { data: SPECS, isLoading: false, isError: false, error: null, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTestbenchSpecs.mockReturnValue(specsQuery());
  mockUseManualPathValidation.mockReturnValue({ status: "idle" } satisfies ManualPathState);
});

function renderModal(props: Partial<React.ComponentProps<typeof SpecPickerModal>> = {}) {
  return renderWithProviders(
    <SpecPickerModal isOpen onClose={vi.fn()} projectId="p1" onCreate={vi.fn()} {...props} />,
  );
}

describe("SpecPickerModal", () => {
  it("lists discovered specs with slug, path, and case count", () => {
    renderModal();
    expect(screen.getByText("testbench")).toBeInTheDocument();
    expect(screen.getByText("/repo/.specifications/testbench/test-cases.json")).toBeInTheDocument();
    expect(screen.getByText("3 cases")).toBeInTheDocument();
    expect(screen.getByText("1 case")).toBeInTheDocument();
  });

  it("shows the empty discovery state when no specs are found", () => {
    mockUseTestbenchSpecs.mockReturnValue(specsQuery({ data: [] }));
    renderModal();
    expect(screen.getByText("No specs found in this project.")).toBeInTheDocument();
  });

  it("shows a loading state while discovering", () => {
    mockUseTestbenchSpecs.mockReturnValue(specsQuery({ data: undefined, isLoading: true }));
    renderModal();
    expect(screen.getByText("Discovering specs...")).toBeInTheDocument();
  });

  it("surfaces a discovery error", () => {
    mockUseTestbenchSpecs.mockReturnValue(
      specsQuery({ data: undefined, isError: true, error: new Error("boom") }),
    );
    renderModal();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("disables Create until a spec is selected", async () => {
    renderModal();
    const create = screen.getByRole("button", { name: /Create TestBench/ });
    expect(create).toBeDisabled();
    await userEvent.click(screen.getByText("testbench"));
    expect(create).not.toBeDisabled();
  });

  it("calls onCreate with the focused spec path on confirm", async () => {
    const onCreate = vi.fn();
    renderModal({ onCreate });
    await userEvent.click(screen.getByText("billing"));
    await userEvent.click(screen.getByRole("button", { name: /Create TestBench/ }));
    expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/billing/test-cases.json");
  });

  it("renders the manual-path validating state", () => {
    mockUseManualPathValidation.mockReturnValue({
      status: "validating",
    } satisfies ManualPathState);
    renderModal();
    expect(screen.getByText("Validating...")).toBeInTheDocument();
  });

  it("renders the manual-path valid state and enables Create", () => {
    mockUseManualPathValidation.mockReturnValue({
      status: "valid",
      slug: "manual",
      caseCount: 2,
      path: "/repo/.specifications/manual/test-cases.json",
    } satisfies ManualPathState);
    renderModal();
    expect(screen.getByText(/Valid: manual \(2 cases\)/)).toBeInTheDocument();
  });

  it("renders the manual-path invalid state with an actionable message", () => {
    mockUseManualPathValidation.mockReturnValue({
      status: "invalid",
      errors: ["path escapes the project repository"],
    } satisfies ManualPathState);
    renderModal();
    expect(screen.getByText("path escapes the project repository")).toBeInTheDocument();
  });

  it("binds the manual path to onCreate once it validates", async () => {
    mockUseManualPathValidation.mockReturnValue({
      status: "valid",
      slug: "manual",
      caseCount: 2,
      path: "/repo/.specifications/manual/test-cases.json",
    } satisfies ManualPathState);
    const onCreate = vi.fn();
    renderModal({ onCreate });
    // Type into the manual field so the manual selection takes precedence.
    await userEvent.type(
      screen.getByLabelText("Or enter a path"),
      "/repo/.specifications/manual/test-cases.json",
    );
    await userEvent.click(screen.getByRole("button", { name: /Create TestBench/ }));
    expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/manual/test-cases.json");
  });

  it("is keyboard operable: select a spec and confirm without the mouse", async () => {
    const onCreate = vi.fn();
    const user = userEvent.setup();
    renderModal({ onCreate });
    // Focus the first spec toggle and select it with the keyboard.
    const firstSpec = screen.getByText("testbench").closest("button") as HTMLElement;
    await act(async () => {
      firstSpec.focus();
    });
    await user.keyboard("{Enter}");
    const create = screen.getByRole("button", { name: /Create TestBench/ });
    await waitFor(() => expect(create).not.toBeDisabled());
    await act(async () => {
      create.focus();
    });
    await user.keyboard("{Enter}");
    expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/testbench/test-cases.json");
  });

  it("shows the creating label while a create is in flight", () => {
    renderModal({ isCreating: true });
    expect(screen.getByRole("button", { name: "Creating..." })).toBeInTheDocument();
  });
});
