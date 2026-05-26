// @vitest-environment jsdom
//
// WU-036 / TC-099: zero serious axe violations on the SourcePicker warning
// chip across every variant the dispatcher can produce, plus the keyboard /
// live-region assertions from TC-099 (the chip is keyboard-reachable via Tab,
// Enter and Space activate the re-consent handler, and the chip's accessible
// name exposes the warning cause to screen readers).

import { describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import type { ListIssuesWarning } from "@roubo/plugin-sdk";
import { WarningChip } from "./SourcePicker";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}

expect.extend({ toHaveNoViolations });

function warning(overrides: Partial<ListIssuesWarning> = {}): ListIssuesWarning {
  return {
    category: "dependabot",
    sourceExternalId: "foo/bar",
    cause: "Dependabot alerts unavailable: missing security_events scope on the GitHub token.",
    code: "missing-scope",
    detail: { status: 401, missingScope: "security_events" },
    ...overrides,
  };
}

describe("SourcePicker WarningChip — axe-core (WU-036)", () => {
  it("has no axe violations on the github.com missing-scope chip", async () => {
    const { container } = render(
      <WarningChip
        warning={warning({ code: "missing-scope" })}
        chipContext={{ pluginId: "github-com" }}
        onReconsent={() => {}}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations on the GHE missing-scope chip (link variant)", async () => {
    const { container } = render(
      <WarningChip
        warning={warning({ code: "missing-scope" })}
        chipContext={{
          pluginId: "ghe",
          gheInstanceUrl: "https://github.acme.example",
        }}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations on the scope-unverifiable chip", async () => {
    const { container } = render(
      <WarningChip
        warning={warning({
          code: "scope-unverifiable",
          cause:
            "Unable to verify token scopes. If category data is missing, regenerate your token with the security alert permission.",
          detail: undefined,
        })}
        chipContext={{ pluginId: "github-com" }}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations on the generic Unavailable chip", async () => {
    const { container } = render(
      <WarningChip
        warning={warning({
          code: "not-found",
          cause: "Code Scanning unavailable: GHAS not enabled on this repo.",
          category: "code-scanning",
          detail: { status: 404 },
        })}
        chipContext={{ pluginId: "github-com" }}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations after a cancelled re-consent shows the Retry hint", async () => {
    const { container } = render(
      <WarningChip
        warning={warning({ code: "missing-scope" })}
        chipContext={{ pluginId: "github-com" }}
        onReconsent={() => {}}
        showRetry
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  // TC-099 keyboard reachability + activation assertions.

  it("TC-099: github.com missing-scope chip is keyboard-reachable and Enter activates it", async () => {
    const user = userEvent.setup();
    const onReconsent = vi.fn();
    render(
      <WarningChip
        warning={warning({ code: "missing-scope" })}
        chipContext={{ pluginId: "github-com" }}
        onReconsent={onReconsent}
      />,
    );

    const chip = screen.getByTestId("alert-chip-missing-scope-github-com");
    await act(async () => {
      await user.tab();
    });
    expect(chip).toHaveFocus();

    // React Aria's Button transitions `isPressed` state on keydown / keyup, so
    // wrap the keyboard interaction in act() to flush both microtasks before
    // assertions run.
    await act(async () => {
      await user.keyboard("{Enter}");
    });
    expect(onReconsent).toHaveBeenCalledTimes(1);
  });

  it("TC-099: github.com missing-scope chip activates on Space as well", async () => {
    const user = userEvent.setup();
    const onReconsent = vi.fn();
    render(
      <WarningChip
        warning={warning({ code: "missing-scope" })}
        chipContext={{ pluginId: "github-com" }}
        onReconsent={onReconsent}
      />,
    );

    const chip = screen.getByTestId("alert-chip-missing-scope-github-com");
    await act(async () => {
      chip.focus();
    });
    expect(chip).toHaveFocus();

    await act(async () => {
      await user.keyboard(" ");
    });
    expect(onReconsent).toHaveBeenCalledTimes(1);
  });

  it("TC-099: the chip's accessible description exposes the warning cause to screen readers", () => {
    render(
      <WarningChip
        warning={warning({ code: "missing-scope" })}
        chipContext={{ pluginId: "github-com" }}
        onReconsent={() => {}}
      />,
    );
    const chip = screen.getByTestId("alert-chip-missing-scope-github-com");
    const describedBy = chip.getAttribute("aria-describedby");
    if (!describedBy) throw new Error("expected aria-describedby on the chip");
    const description = document.getElementById(describedBy);
    expect(description?.textContent).toContain("security_events");
  });
});
