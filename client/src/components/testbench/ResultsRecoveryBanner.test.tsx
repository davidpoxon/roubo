// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ResultsRecoveryBanner from "./ResultsRecoveryBanner";

describe("ResultsRecoveryBanner", () => {
  // TC-046 (NFR-003): a corrupt sidecar surfaces the recovery prompt.
  it("renders the recovery banner for a corrupt sidecar", () => {
    render(<ResultsRecoveryBanner recoveryReason="corrupt-json" />);
    const banner = screen.getByTestId("results-recovery-banner");
    expect(banner).toBeTruthy();
    expect(banner.getAttribute("data-recovery")).toBe("corrupt-json");
    expect(screen.getByText(/could not be read/i)).toBeTruthy();
  });

  // A schema-invalid sidecar folds into the same "could not be read" prompt.
  it("renders the recovery banner for a schema-invalid sidecar", () => {
    render(<ResultsRecoveryBanner recoveryReason="schema-invalid" />);
    expect(screen.getByTestId("results-recovery-banner")).toBeTruthy();
    expect(screen.getByText(/could not be read/i)).toBeTruthy();
  });

  // TC-048 (NFR-003): a future-version sidecar surfaces a distinct prompt.
  it("renders a distinct message for a future-version sidecar", () => {
    render(<ResultsRecoveryBanner recoveryReason="future-version" />);
    expect(screen.getByTestId("results-recovery-banner")).toBeTruthy();
    expect(screen.getByText(/newer version of Roubo/i)).toBeTruthy();
  });

  // A prior-major sidecar (#896 version-migration-required) surfaces a distinct
  // "earlier version, needs migration" prompt.
  it("renders a distinct message for a version-migration-required sidecar", () => {
    render(<ResultsRecoveryBanner recoveryReason="version-migration-required" />);
    expect(screen.getByTestId("results-recovery-banner")).toBeTruthy();
    expect(screen.getByText(/earlier version of Roubo/i)).toBeTruthy();
    // Issue #469 (AC1/AC3): the migration copy names the documented migration
    // path so a user can find the migration steps from the banner itself.
    expect(screen.getByText(/docs\/testbench-schema-migrations\.md/i)).toBeTruthy();
  });

  // TC-047: a MISSING sidecar is the clean initial state, so no prompt.
  it("renders nothing for a missing sidecar", () => {
    const { container } = render(<ResultsRecoveryBanner recoveryReason="missing" />);
    expect(screen.queryByTestId("results-recovery-banner")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  // A clean read (null) raises no banner.
  it("renders nothing when the recovery reason is null", () => {
    const { container } = render(<ResultsRecoveryBanner recoveryReason={null} />);
    expect(screen.queryByTestId("results-recovery-banner")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  // Tolerant of an older server that omits the reason.
  it("renders nothing when the recovery reason is absent", () => {
    const { container } = render(<ResultsRecoveryBanner />);
    expect(screen.queryByTestId("results-recovery-banner")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  // The banner is dismissible: pressing the close control hides it.
  it("hides the banner when the dismiss control is pressed", async () => {
    const user = userEvent.setup();
    render(<ResultsRecoveryBanner recoveryReason="corrupt-json" />);
    expect(screen.getByTestId("results-recovery-banner")).toBeTruthy();
    await user.click(screen.getByTestId("results-recovery-banner-dismiss"));
    expect(screen.queryByTestId("results-recovery-banner")).toBeNull();
  });
});
