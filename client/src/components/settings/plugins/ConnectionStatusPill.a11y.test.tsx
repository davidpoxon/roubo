// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
// vitest-axe@0.1.0 mis-declares its top-level `matchers` entry as a `export type *`
// re-export, so the runtime value disappears in TS. The dist path is unaffected.
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import type { ConnectionState } from "@roubo/shared";
import ConnectionStatusPill from "./ConnectionStatusPill";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}

expect.extend({ toHaveNoViolations });

const FIXED_CHECKED_AT = new Date(2026, 4, 19, 9, 7, 0).toISOString();

const VARIANTS: { state: ConnectionState; detail?: string }[] = [
  { state: "connected" },
  { state: "disconnected" },
  { state: "auth-problem", detail: "Token expired 2 hours ago. Click Configure to sign in again." },
  { state: "errored", detail: "Rate-limited until 14:42 UTC. Cut list shows last-known data." },
  { state: "disabled" },
];

describe("ConnectionStatusPill — axe-core a11y (TC-134 intent: zero contrast violations)", () => {
  for (const variant of VARIANTS) {
    it(`has no axe violations on the ${variant.state} variant`, async () => {
      const { container } = render(
        <ConnectionStatusPill
          status={{
            state: variant.state,
            detail: variant.detail,
            checkedAt: variant.state === "disabled" ? undefined : FIXED_CHECKED_AT,
          }}
        />,
      );
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  }

  it("has no axe violations in the rechecking state", async () => {
    const { container } = render(
      <ConnectionStatusPill
        status={{ state: "connected", checkedAt: FIXED_CHECKED_AT }}
        rechecking
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
