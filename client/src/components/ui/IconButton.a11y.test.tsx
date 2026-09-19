// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { Trash2 } from "lucide-react";
import IconButton from "./IconButton";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("IconButton: axe-core in both themes", () => {
  for (const theme of THEMES) {
    it(`has no axe findings enabled and disabled in ${theme}`, async () => {
      const { container } = renderInTheme(
        <div>
          <IconButton label="Clear bench" tone="danger">
            <Trash2 size={14} />
          </IconButton>
          <IconButton label="Start" tone="primary" isDisabled tooltip="Bench is clearing">
            <Trash2 size={14} />
          </IconButton>
        </div>,
        theme,
      );
      expectNoAxeFindings(await axe(container));
    });
  }
});

describe("IconButton: behaviour", () => {
  it("names the button with its label and presses through", async () => {
    const onPress = vi.fn();
    renderInTheme(
      <IconButton label="Stop all components" onPress={onPress} data-testid="stop">
        <Trash2 size={14} />
      </IconButton>,
      "light",
    );
    const button = screen.getByRole("button", { name: "Stop all components" });
    expect(button).toHaveAttribute("data-testid", "stop");
    await userEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("shows its tooltip on keyboard focus", async () => {
    renderInTheme(
      <IconButton label="Collapse sidebar">
        <Trash2 size={14} />
      </IconButton>,
      "dark",
    );
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Collapse sidebar");
  });

  it("still shows its tooltip when disabled, and ignores press", async () => {
    const onPress = vi.fn();
    renderInTheme(
      <IconButton label="Clear bench" tooltip="Clearing in progress" isDisabled onPress={onPress}>
        <Trash2 size={14} />
      </IconButton>,
      "light",
    );
    const button = screen.getByRole("button", { name: "Clear bench" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button.className).toContain("opacity-40");
    await userEvent.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Clearing in progress");
    await userEvent.click(button);
    await userEvent.keyboard("{Enter}");
    expect(onPress).not.toHaveBeenCalled();
  });
});
