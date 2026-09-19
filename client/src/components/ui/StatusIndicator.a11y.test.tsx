// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import StatusIndicator from "./StatusIndicator";
import type { StatusTone } from "./styles";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

const TONES: StatusTone[] = ["active", "preparing", "error", "idle"];

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("StatusIndicator: axe-core in both themes", () => {
  for (const theme of THEMES) {
    it(`has no axe findings in ${theme}`, async () => {
      const { container } = renderInTheme(
        <div>
          {TONES.map((tone) => (
            <StatusIndicator key={tone} tone={tone} label={tone} />
          ))}
        </div>,
        theme,
      );
      expectNoAxeFindings(await axe(container));
    });
  }
});

describe("StatusIndicator: token contract", () => {
  it("pairs each status dot with its visible label", () => {
    for (const tone of TONES) {
      cleanup();
      renderInTheme(<StatusIndicator tone={tone} label={tone} data-testid="status" />, "light");
      const row = screen.getByTestId("status");
      expect(row).toHaveTextContent(tone);
      expect(row.querySelector(`.bg-status-${tone}`)).not.toBeNull();
    }
  });

  it("pulses while preparing and not otherwise, unless told to", () => {
    renderInTheme(
      <div>
        <StatusIndicator tone="preparing" label="preparing" data-testid="preparing" />
        <StatusIndicator tone="active" label="active" data-testid="active" />
        <StatusIndicator tone="idle" label="clearing" pulse data-testid="clearing" />
      </div>,
      "light",
    );
    expect(screen.getByTestId("preparing").querySelector(".animate-status-pulse")).not.toBeNull();
    expect(screen.getByTestId("active").querySelector(".animate-status-pulse")).toBeNull();
    expect(screen.getByTestId("clearing").querySelector(".animate-status-pulse")).not.toBeNull();
  });
});
