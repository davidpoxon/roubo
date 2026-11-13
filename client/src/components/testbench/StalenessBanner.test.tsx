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

  // #1696: the banner names the cases whose result is still judged against an
  // earlier version of the case, so it says why it stays after a Reconcile.
  it("names the stale cases when it is given them", () => {
    render(<StalenessBanner stale staleCaseIds={["TC-002", "TC-005"]} onReconcile={() => {}} />);
    const banner = screen.getByTestId("staleness-banner");
    expect(banner.textContent).toMatch(/source plan changed/i);
    expect(banner.textContent).toContain("TC-002, TC-005");
    expect(banner.textContent).toMatch(/2 cases have/);
    expect(banner.textContent).toMatch(/mark them again/i);
  });

  it("names at most five stale cases and counts the rest", () => {
    const ids = ["TC-1", "TC-2", "TC-3", "TC-4", "TC-5", "TC-6", "TC-7"];
    render(<StalenessBanner stale staleCaseIds={ids} />);
    const text = screen.getByTestId("staleness-banner").textContent ?? "";
    expect(text).toContain("TC-1, TC-2, TC-3, TC-4, TC-5 and 2 more");
    expect(text).not.toContain("TC-6");
  });

  it("keeps the plain message when no case is stale", () => {
    render(<StalenessBanner stale staleCaseIds={[]} />);
    const text = screen.getByTestId("staleness-banner").textContent ?? "";
    expect(text).toMatch(/source plan changed/i);
    expect(text).not.toMatch(/mark them again/i);
  });

  it("invokes onReconcile when the action is pressed", async () => {
    const onReconcile = vi.fn();
    const user = userEvent.setup();
    render(<StalenessBanner stale onReconcile={onReconcile} />);
    await user.click(screen.getByRole("button", { name: "Reconcile" }));
    expect(onReconcile).toHaveBeenCalledTimes(1);
  });
});
