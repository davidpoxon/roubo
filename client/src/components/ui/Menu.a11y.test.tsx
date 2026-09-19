// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { Button } from "react-aria-components";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "./Menu";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

afterEach(() => {
  cleanup();
  resetTheme();
});

function Example() {
  return (
    <MenuTrigger defaultOpen>
      <Button>Actions</Button>
      <MenuPopover className="w-52">
        <Menu aria-label="Bench actions" className="py-0">
          <MenuItem id="open">Open in editor</MenuItem>
          <MenuItem id="copy" className="font-mono">
            Copy branch
          </MenuItem>
          <MenuItem id="archive" isDisabled>
            Archive
          </MenuItem>
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

describe("Menu: axe-core in both themes", () => {
  for (const theme of THEMES) {
    it(`has no axe findings when open in ${theme}`, async () => {
      renderInTheme(<Example />, theme);
      await screen.findByRole("menu");
      expectNoAxeFindings(await axe(document.body));
    });
  }
});

describe("Menu: token contract", () => {
  it("floats at elevation.0 on the surface, and items take a wash, never a border", async () => {
    renderInTheme(<Example />, "light");
    const menu = await screen.findByRole("menu");
    const popover = menu.closest(".shadow-elevation-0") as HTMLElement;
    expect(popover).not.toBeNull();
    expect(popover.className).toContain("bg-bg-surface");
    expect(popover.className).toContain("border-border");
    expect(popover.className).toContain("rounded-control");
    expect(popover.className).toContain("w-52");
    const item = screen.getByRole("menuitem", { name: "Open in editor" });
    expect(item.className).toContain("data-[hovered]:bg-bg-hover");
    expect(item.className).toContain("data-[pressed]:bg-bg-pressed");
    expect(item.className).toContain("rounded-chip");
    expect(item.className).not.toMatch(/(^|\s)border(\s|-)/);
    expect(screen.getByRole("menuitem", { name: "Copy branch" }).className).toContain("font-mono");
  });
});
