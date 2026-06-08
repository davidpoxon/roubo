// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/renderWithProviders";
import type { DiscoveredSpec, InvalidSpec } from "../../lib/api";
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
  return {
    data: { specs: SPECS, invalid: [] },
    isLoading: false,
    isError: false,
    error: null,
    ...over,
  };
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
    mockUseTestbenchSpecs.mockReturnValue(specsQuery({ data: { specs: [], invalid: [] } }));
    renderModal();
    expect(screen.getByText("No specs found in this project.")).toBeInTheDocument();
  });

  it("surfaces present-but-invalid specs with their errors instead of the empty state", () => {
    const invalid: InvalidSpec[] = [
      {
        slug: "broken",
        path: "/repo/.specifications/broken/test-cases.json",
        errors: ["cases.0.level: Invalid input: expected number, received string"],
      },
    ];
    mockUseTestbenchSpecs.mockReturnValue(specsQuery({ data: { specs: [], invalid } }));
    renderModal();
    expect(screen.queryByText("No specs found in this project.")).not.toBeInTheDocument();
    expect(
      screen.getByText("1 spec file does not match the schema and was skipped:"),
    ).toBeInTheDocument();
    expect(screen.getByText("broken")).toBeInTheDocument();
    expect(
      screen.getByText("cases.0.level: Invalid input: expected number, received string"),
    ).toBeInTheDocument();
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

  describe("re-point mode (#423)", () => {
    it("uses the re-point title, helper text, and confirm label", () => {
      renderModal({ mode: "repoint" });
      expect(screen.getByText("Change focused spec")).toBeInTheDocument();
      expect(screen.getByText(/Re-point this TestBench/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Re-point TestBench/ })).toBeInTheDocument();
      // The create copy must not leak into re-point mode.
      expect(screen.queryByText("Create a TestBench")).not.toBeInTheDocument();
    });

    it("shows the re-pointing busy label while a re-point is in flight", () => {
      renderModal({ mode: "repoint", isCreating: true });
      expect(screen.getByRole("button", { name: "Re-pointing..." })).toBeInTheDocument();
    });

    it("confirms a re-point with the chosen spec path", async () => {
      const onCreate = vi.fn();
      renderModal({ mode: "repoint", onCreate });
      await userEvent.click(screen.getByText("billing"));
      await userEvent.click(screen.getByRole("button", { name: /Re-point TestBench/ }));
      expect(onCreate).toHaveBeenCalledWith("/repo/.specifications/billing/test-cases.json");
    });

    it("flags the currently focused spec row as Active (#444, TC-007 step 2)", () => {
      renderModal({
        mode: "repoint",
        activePath: "/repo/.specifications/testbench/test-cases.json",
      });
      const badge = screen.getByText("Active");
      expect(badge).toBeInTheDocument();
      // The badge sits on the active spec's row, not the other discovered spec.
      const activeRow = screen
        .getByText("/repo/.specifications/testbench/test-cases.json")
        .closest("button") as HTMLElement;
      const otherRow = screen
        .getByText("/repo/.specifications/billing/test-cases.json")
        .closest("button") as HTMLElement;
      expect(activeRow).toContainElement(badge);
      expect(otherRow).not.toContainElement(badge);
    });

    it("does not render an Active badge in create mode even when an activePath is passed", () => {
      renderModal({
        mode: "create",
        activePath: "/repo/.specifications/testbench/test-cases.json",
      });
      expect(screen.queryByText("Active")).not.toBeInTheDocument();
    });

    it("dismissing via Cancel leaves the focused spec unchanged (no onCreate, explicit only)", async () => {
      const onCreate = vi.fn();
      const onClose = vi.fn();
      renderModal({ mode: "repoint", onCreate, onClose });
      // Pick a spec but then cancel instead of confirming.
      await userEvent.click(screen.getByText("billing"));
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCreate).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });
});
