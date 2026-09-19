// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import Callout from "./Callout";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("Callout: axe-core in both themes", () => {
  for (const theme of THEMES) {
    it(`has no axe findings for both variants in ${theme}`, async () => {
      const { container } = renderInTheme(
        <div>
          <Callout title="Component 'database' failed to start" role="alert">
            Port 1434 in use. Stop the other process or change ports.database in roubo.yaml.
          </Callout>
          <Callout variant="success" title="Plugin installed" />
          <Callout variant="success">Saved.</Callout>
        </div>,
        theme,
      );
      expectNoAxeFindings(await axe(container));
    });
  }
});

describe("Callout: token contract", () => {
  it("puts the cause in danger-text on danger-surface", () => {
    renderInTheme(
      <Callout title="Failed" data-testid="callout" className="mt-2">
        Fix it
      </Callout>,
      "light",
    );
    const frame = screen.getByTestId("callout");
    expect(frame.className).toContain("bg-danger-surface");
    expect(frame.className).toContain("border-danger-border");
    expect(frame.className).toContain("mt-2");
    expect(screen.getByText("Failed").className).toContain("text-danger-text");
    expect(screen.getByText("Fix it").className).toContain("text-text-body");
  });

  it("swaps the three success tokens for the success variant", () => {
    renderInTheme(<Callout variant="success" title="Done" data-testid="callout" />, "dark");
    const frame = screen.getByTestId("callout");
    expect(frame.className).toContain("bg-success-surface");
    expect(frame.className).toContain("border-success-border");
    expect(screen.getByText("Done").className).toContain("text-success-text");
  });
});
