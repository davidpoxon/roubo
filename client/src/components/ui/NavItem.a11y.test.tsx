// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import NavItem from "./NavItem";
import { navItemClass } from "./styles";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("NavItem: axe-core in both themes", () => {
  for (const theme of THEMES) {
    it(`has no axe findings in ${theme}`, async () => {
      const { container } = renderInTheme(
        <nav>
          <NavItem isSelected>roubo</NavItem>
          <NavItem>roubo-plugins</NavItem>
          <NavItem isDisabled>archived</NavItem>
        </nav>,
        theme,
      );
      expectNoAxeFindings(await axe(container));
    });
  }
});

describe("NavItem: token contract", () => {
  it("sets the selected row on accent-muted in accent-text and marks it current", () => {
    renderInTheme(
      <nav>
        <NavItem isSelected className="w-full">
          roubo
        </NavItem>
        <NavItem>roubo-plugins</NavItem>
      </nav>,
      "dark",
    );
    const selected = screen.getByRole("button", { name: "roubo" });
    expect(selected).toHaveAttribute("aria-current", "page");
    expect(selected.className).toContain("bg-accent-muted");
    expect(selected.className).toContain("text-accent-text");
    expect(selected.className).toContain("w-full");
    const resting = screen.getByRole("button", { name: "roubo-plugins" });
    expect(resting).not.toHaveAttribute("aria-current");
    expect(resting.className).toContain("data-[hovered]:bg-bg-hover");
  });

  it("rings tight in focus-ring at 2px on a 6px row", () => {
    const cls = navItemClass(false);
    expect(cls).toContain("focus-visible:ring-2");
    expect(cls).toContain("focus-visible:ring-focus-ring");
    expect(cls).not.toContain("ring-offset");
    expect(cls).toContain("rounded-control");
  });
});
