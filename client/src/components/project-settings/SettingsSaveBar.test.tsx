// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsSaveBar } from "./SettingsSaveBar";

function renderBar(props: Partial<React.ComponentProps<typeof SettingsSaveBar>> = {}) {
  return render(
    <SettingsSaveBar
      hasAnyDirty={props.hasAnyDirty ?? false}
      isSaving={props.isSaving ?? false}
      saveErrors={props.saveErrors ?? []}
      onSave={props.onSave ?? vi.fn()}
      onDiscard={props.onDiscard ?? vi.fn()}
    />,
  );
}

describe("SettingsSaveBar", () => {
  it("is hidden when hasAnyDirty is false", () => {
    renderBar({ hasAnyDirty: false });
    const bar = screen.getByTestId("settings-save-bar");
    expect(bar).toHaveClass("h-0", "overflow-hidden", "opacity-0");
    expect(bar).not.toHaveClass("translate-y-full");
  });

  it("is visible when hasAnyDirty is true", () => {
    renderBar({ hasAnyDirty: true });
    const bar = screen.getByTestId("settings-save-bar");
    expect(bar).toHaveClass("opacity-100");
    expect(bar).not.toHaveClass("h-0", "opacity-0");
  });

  it("shows unsaved changes message when no errors", () => {
    renderBar({ hasAnyDirty: true });
    expect(screen.getByText("You have unsaved changes")).toBeInTheDocument();
  });

  it("shows error message when saveErrors is non-empty", () => {
    renderBar({
      hasAnyDirty: true,
      saveErrors: ["Workspace source", "Blueprint override"],
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/Workspace source/)).toBeInTheDocument();
    expect(screen.getByText(/Blueprint override/)).toBeInTheDocument();
  });

  it("renders Save changes button", () => {
    renderBar({ hasAnyDirty: true });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("renders Discard button", () => {
    renderBar({ hasAnyDirty: true });
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
  });

  it("calls onSave when Save changes is clicked", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderBar({ hasAnyDirty: true, onSave });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalled();
  });

  it("calls onDiscard when Discard is clicked", async () => {
    const onDiscard = vi.fn();
    const user = userEvent.setup();
    renderBar({ hasAnyDirty: true, onDiscard });
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalled();
  });

  it("shows Saving… label while isSaving", () => {
    renderBar({ hasAnyDirty: true, isSaving: true });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument();
  });

  it("Save button is disabled while isSaving", () => {
    renderBar({ hasAnyDirty: true, isSaving: true });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("Discard button is disabled while isSaving", () => {
    renderBar({ hasAnyDirty: true, isSaving: true });
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });

  it("Save button is disabled when hasAnyDirty is false", () => {
    renderBar({ hasAnyDirty: false });
    expect(screen.getByRole("button", { name: "Save changes", hidden: true })).toBeDisabled();
  });

  it("Discard button has a focus-visible ring class for keyboard accessibility", () => {
    renderBar({ hasAnyDirty: true });
    const discard = screen.getByRole("button", { name: "Discard" });
    expect(discard.className).toContain("data-[focus-visible]:ring-2");
  });

  it("is aria-hidden when hasAnyDirty is false", () => {
    renderBar({ hasAnyDirty: false });
    expect(screen.getByTestId("settings-save-bar")).toHaveAttribute("aria-hidden", "true");
  });

  it("is not aria-hidden when hasAnyDirty is true", () => {
    renderBar({ hasAnyDirty: true });
    expect(screen.getByTestId("settings-save-bar")).toHaveAttribute("aria-hidden", "false");
  });
});
