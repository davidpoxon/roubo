// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import Dialog, { DIALOG_ACTIONS_CLASS } from "./Dialog";
import Button from "./Button";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("Dialog: axe-core in both themes", () => {
  for (const theme of THEMES) {
    it(`has no axe findings when open in ${theme}`, async () => {
      renderInTheme(
        <Dialog isOpen title="Clear Bench 3?" role="alertdialog">
          {({ close }) => (
            <>
              <p>This removes the workspace and stops all components.</p>
              <div className={DIALOG_ACTIONS_CLASS}>
                <Button onPress={close}>Cancel</Button>
                <Button variant="danger">Clear bench</Button>
              </div>
            </>
          )}
        </Dialog>,
        theme,
      );
      await screen.findByRole("alertdialog");
      expectNoAxeFindings(await axe(document.body));
    });
  }
});

describe("Dialog: token contract", () => {
  it("sits at elevation.1 on the surface over the scrim, with a 12px radius", async () => {
    renderInTheme(
      <Dialog isOpen title="Clear bench" widthClassName="max-w-sm" className="gap-4">
        <p>Body</p>
      </Dialog>,
      "dark",
    );
    const dialog = await screen.findByRole("dialog", { name: "Clear bench" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.className).toContain("bg-bg-surface");
    expect(dialog.className).toContain("rounded-card");
    expect(dialog.className).toContain("shadow-elevation-1");
    expect(dialog.className).toContain("gap-4");
    expect(dialog.closest(".bg-scrim")).not.toBeNull();
    expect(dialog.closest(".max-w-sm")).not.toBeNull();
  });

  it("closes through the render-prop close", async () => {
    const onOpenChange = vi.fn();
    renderInTheme(
      <Dialog isOpen onOpenChange={onOpenChange} title="Confirm">
        {({ close }) => <Button onPress={close}>Cancel</Button>}
      </Dialog>,
      "light",
    );
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
