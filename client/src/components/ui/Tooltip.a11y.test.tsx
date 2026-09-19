// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { Button, TooltipTrigger } from "react-aria-components";
import Tooltip from "./Tooltip";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("Tooltip: axe-core in both themes", () => {
  for (const theme of THEMES) {
    it(`has no axe findings when open in ${theme}`, async () => {
      const { container } = renderInTheme(
        <TooltipTrigger isOpen>
          <Button>Start</Button>
          <Tooltip className="whitespace-nowrap">Start all components on this bench</Tooltip>
        </TooltipTrigger>,
        theme,
      );
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.className).toContain("bg-bg-inverse");
      expect(tooltip.className).toContain("text-text-on-inverse");
      expect(tooltip.className).toContain("shadow-elevation-0");
      expect(tooltip.className).toContain("whitespace-nowrap");
      expectNoAxeFindings(await axe(container));
      expectNoAxeFindings(await axe(tooltip));
    });
  }
});
