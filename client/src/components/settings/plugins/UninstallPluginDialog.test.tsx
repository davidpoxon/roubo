// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, DialogTrigger } from "react-aria-components";
import UninstallPluginDialog from "./UninstallPluginDialog";

// The dialog has no isOpen of its own: it is driven by an enclosing
// DialogTrigger (as it is inside PluginCard). Mount it open via a trigger.
function renderOpen(props: Partial<React.ComponentProps<typeof UninstallPluginDialog>> = {}) {
  const onConfirm = props.onConfirm ?? vi.fn();
  render(
    <DialogTrigger defaultOpen>
      <Button>open</Button>
      <UninstallPluginDialog pluginName="Redis" onConfirm={onConfirm} {...props} />
    </DialogTrigger>,
  );
  return { onConfirm };
}

describe("UninstallPluginDialog", () => {
  it("renders the uninstall confirmation", () => {
    renderOpen();
    expect(screen.getByRole("heading", { name: /uninstall redis\?/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^uninstall$/i })).toBeInTheDocument();
  });

  it("calls onConfirm when Uninstall is pressed", async () => {
    const { onConfirm } = renderOpen();
    await userEvent.click(screen.getByRole("button", { name: /^uninstall$/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // Issue #612 / #424: React Aria omits aria-modal and strips the prop, so the
  // shared stampAriaModal ref is what makes the modality explicit to AT.
  it("stamps aria-modal on the dialog", () => {
    renderOpen();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });
});
