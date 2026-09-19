// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { axe } from "vitest-axe";
import Button from "./Button";
import { buttonClass, type ButtonVariant } from "./styles";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

const VARIANTS: ButtonVariant[] = ["primary", "secondary", "danger"];

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("Button: axe-core in both themes", () => {
  for (const theme of THEMES) {
    for (const variant of VARIANTS) {
      it(`has no axe findings for ${variant} in ${theme}`, async () => {
        const { container } = renderInTheme(
          <div>
            <Button variant={variant}>Start</Button>
            <Button variant={variant} isDisabled>
              Start
            </Button>
          </div>,
          theme,
        );
        expectNoAxeFindings(await axe(container));
      });
    }
  }
});

describe("Button: token contract", () => {
  it("rings every variant in focus-ring at 2px with a 2px offset", () => {
    for (const variant of VARIANTS) {
      const cls = buttonClass(variant);
      expect(cls).toContain("focus-visible:ring-2");
      expect(cls).toContain("focus-visible:ring-focus-ring");
      expect(cls).toContain("focus-visible:ring-offset-2");
      expect(cls).toContain("rounded-control");
      expect(cls).toContain("disabled:opacity-40");
      expect(cls).not.toMatch(/hover:opacity|dark:/);
    }
  });

  it("rests danger on danger and darkens through danger-hover to danger-active", () => {
    const cls = buttonClass("danger");
    expect(cls).toContain("bg-danger ");
    expect(cls).toContain("text-on-danger");
    expect(cls).toContain("data-[hovered]:bg-danger-hover");
    expect(cls).toContain("data-[pressed]:bg-danger-active");
  });

  it("defaults to the secondary style and appends layout classes", () => {
    const cls = buttonClass(undefined, "w-full");
    expect(cls).toContain("border-border-strong");
    expect(cls.endsWith("w-full")).toBe(true);
  });
});
