// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import TextField from "./TextField";
import { INPUT_CLASS, inputClass } from "./styles";
import { expectNoAxeFindings } from "../../test/axe";
import { THEMES, renderInTheme, resetTheme } from "../../test/themes";

afterEach(() => {
  cleanup();
  resetTheme();
});

describe("TextField: axe-core in both themes", () => {
  for (const theme of THEMES) {
    it(`has no axe findings at rest, invalid, and disabled in ${theme}`, async () => {
      const { container } = renderInTheme(
        <div>
          <TextField
            label="Repository path"
            placeholder="/path/to/your/repo"
            mono
            description="Absolute path"
          />
          <TextField label="Bench limit" isInvalid errorMessage="Enter a number from 1 to 20." />
          <TextField aria-label="Branch" isDisabled />
        </div>,
        theme,
      );
      expectNoAxeFindings(await axe(container));
    });
  }
});

describe("TextField: token contract", () => {
  it("sits on bg-field inside the border-control boundary and rings in focus-ring", () => {
    expect(INPUT_CLASS).toContain("bg-bg-field");
    expect(INPUT_CLASS).toContain("border-border-control");
    expect(INPUT_CLASS).toContain("focus:border-focus-ring");
    expect(INPUT_CLASS).toContain("focus:ring-2");
    expect(INPUT_CLASS).toContain("focus:ring-focus-ring");
    expect(INPUT_CLASS).toContain("rounded-control");
    expect(INPUT_CLASS).toContain("disabled:opacity-40");
  });

  it("takes the danger border and shows a danger-text message when invalid", () => {
    renderInTheme(
      <TextField label="Port" isInvalid errorMessage="Port 1434 is in use." />,
      "light",
    );
    const input = screen.getByRole("textbox", { name: "Port" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.className).toContain("data-[invalid]:border-danger");
    const message = screen.getByText("Port 1434 is in use.");
    expect(message.className).toContain("text-danger-text");
  });

  it("sets paths in mono when asked", () => {
    expect(inputClass({ mono: true })).toContain("font-mono");
    expect(inputClass()).not.toContain("font-mono");
    expect(inputClass({ className: "w-24" })).toContain("w-24");
  });
});
