// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReconcileClassification } from "@roubo/shared/testbench-domain";
import ReconcileDialog from "./ReconcileDialog";

const classification: ReconcileClassification = {
  added: ["TC-100", "TC-101"],
  unchanged: ["TC-001"],
  changed: ["TC-050"],
  removed: ["TC-900", "TC-901"],
};

function renderDialog(overrides: Partial<React.ComponentProps<typeof ReconcileDialog>> = {}) {
  const onApply = vi.fn();
  const onPurge = vi.fn();
  const onClose = vi.fn();
  render(
    <ReconcileDialog
      isOpen
      onClose={onClose}
      classification={classification}
      onApply={onApply}
      onPurge={onPurge}
      {...overrides}
    />,
  );
  return { onApply, onPurge, onClose };
}

describe("ReconcileDialog", () => {
  // TC-042: the dialog lists changed, orphan, and not-yet-recorded cases;
  // orphans clearly marked and retained.
  it("renders Changed, Orphaned, and Not-yet-recorded sections with their case ids", () => {
    renderDialog();
    const added = screen.getByTestId("reconcile-section-added");
    const changed = screen.getByTestId("reconcile-section-changed");
    const orphan = screen.getByTestId("reconcile-section-orphan");

    expect(added.textContent).toContain("TC-100");
    expect(added.textContent).toContain("TC-101");
    expect(changed.textContent).toContain("TC-050");
    expect(orphan.textContent).toContain("TC-900");
    expect(orphan.textContent).toContain("TC-901");
    // Orphans are described as retained, never deleted.
    expect(orphan.textContent).toMatch(/retained/i);
    expect(orphan.textContent).toMatch(/never deleted/i);
  });

  // #504: the former "Added" bucket is reframed as informational "Not yet
  // recorded", made clear that Apply does not touch these cases.
  it("reframes the added section as not-yet-recorded and informational", () => {
    renderDialog();
    const added = screen.getByTestId("reconcile-section-added");
    expect(added.textContent).toMatch(/not yet recorded/i);
    expect(added.textContent).not.toMatch(/\bAdded\b/);
    // Help text makes clear these cases are unaffected by Apply.
    expect(added.textContent).toMatch(/no recorded result yet/i);
    expect(added.textContent).toMatch(/does not touch them|untouched|leaves/i);
  });

  // #504: actionable sections (Changed, Orphaned) come first; the
  // de-emphasized not-yet-recorded section renders last.
  it("orders sections Changed, Orphaned, then Not-yet-recorded", () => {
    renderDialog();
    const sections = screen.getAllByTestId(/^reconcile-section-(changed|orphan|added)$/);
    expect(sections.map((el) => el.getAttribute("data-testid"))).toEqual([
      "reconcile-section-changed",
      "reconcile-section-orphan",
      "reconcile-section-added",
    ]);
  });

  // TC-042: applying reconcile keeps orphans and shows no purge prompt yet.
  it("apply triggers onApply and does not show the purge confirmation", async () => {
    const user = userEvent.setup();
    const { onApply } = renderDialog();
    expect(screen.getByRole("button", { name: "Apply (keep orphans)" })).toBeTruthy();
    expect(screen.queryByTestId("reconcile-purge-confirm")).toBeNull();
    await user.click(screen.getByTestId("reconcile-apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  // TC-044: purging orphans requires a separate explicit confirmation.
  it("purge requires a second explicit confirmation step", async () => {
    const user = userEvent.setup();
    const { onPurge } = renderDialog();

    // The classification view never purges directly.
    expect(screen.queryByTestId("reconcile-purge-confirm")).toBeNull();

    await user.click(screen.getByTestId("reconcile-purge-trigger"));
    // Now the second confirmation step is shown; the destructive call has not run.
    expect(screen.getByTestId("reconcile-purge-confirm")).toBeTruthy();
    expect(onPurge).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("reconcile-purge-confirm-action"));
    expect(onPurge).toHaveBeenCalledTimes(1);
  });

  // TC-044: canceling the purge confirmation preserves orphans (returns to the
  // classification view, no destructive call).
  it("backing out of the purge confirmation preserves orphans", async () => {
    const user = userEvent.setup();
    const { onPurge } = renderDialog();

    await user.click(screen.getByTestId("reconcile-purge-trigger"));
    expect(screen.getByTestId("reconcile-purge-confirm")).toBeTruthy();

    await user.click(screen.getByTestId("reconcile-purge-back"));
    expect(screen.queryByTestId("reconcile-purge-confirm")).toBeNull();
    expect(screen.getByTestId("reconcile-section-orphan")).toBeTruthy();
    expect(onPurge).not.toHaveBeenCalled();
  });

  it("hides the purge control when there are no orphans", () => {
    renderDialog({ classification: { added: [], unchanged: [], changed: [], removed: [] } });
    expect(screen.queryByTestId("reconcile-purge-trigger")).toBeNull();
  });

  it("renders nothing when closed", () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByTestId("reconcile-section-added")).toBeNull();
  });
});
