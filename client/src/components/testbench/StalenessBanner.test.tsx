// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StalenessBanner from "./StalenessBanner";

describe("StalenessBanner", () => {
  // TC-041: the amber attention banner appears when the source plan's canonical
  // hash changed, with a Reconcile action.
  it("renders the banner with a Reconcile action when stale", () => {
    render(<StalenessBanner stale onReconcile={() => {}} />);
    expect(screen.getByTestId("staleness-banner")).toBeTruthy();
    expect(screen.getByText(/source plan changed/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconcile" })).toBeTruthy();
  });

  // TC-045: a clean (stale=false) plan raises no banner.
  it("renders nothing when not stale", () => {
    const { container } = render(<StalenessBanner stale={false} onReconcile={() => {}} />);
    expect(screen.queryByTestId("staleness-banner")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("invokes onReconcile when the action is pressed", async () => {
    const onReconcile = vi.fn();
    const user = userEvent.setup();
    render(<StalenessBanner stale onReconcile={onReconcile} />);
    await user.click(screen.getByRole("button", { name: "Reconcile" }));
    expect(onReconcile).toHaveBeenCalledTimes(1);
  });
});
