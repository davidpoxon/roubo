// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ConnectionState } from "@roubo/shared";
import ConnectionStatusPill from "./ConnectionStatusPill";

// Tuesday, 2026-05-19T09:07:00 local: yields "as of 09:07" regardless of timezone
// because we format with the *local* hours/minutes of the Date instance.
const FIXED_CHECKED_AT = new Date(2026, 4, 19, 9, 7, 0).toISOString();

interface VariantCase {
  state: ConnectionState;
  label: string;
  /** Token in the wrap classes that distinguishes this variant from the others. */
  wrapToken: string;
}

const VARIANTS: VariantCase[] = [
  { state: "connected", label: "Connected", wrapToken: "bg-emerald-700" },
  { state: "disconnected", label: "Not connected", wrapToken: "bg-stone-300" },
  { state: "auth-problem", label: "Sign in again", wrapToken: "bg-amber-500" },
  { state: "errored", label: "Error", wrapToken: "bg-red-700" },
  { state: "disabled", label: "Disabled", wrapToken: "bg-stone-200" },
];

describe("ConnectionStatusPill: five-variant taxonomy (TC-108)", () => {
  for (const variant of VARIANTS) {
    it(`renders the ${variant.state} variant with label "${variant.label}" and its colour token`, () => {
      render(
        <ConnectionStatusPill status={{ state: variant.state, checkedAt: FIXED_CHECKED_AT }} />,
      );
      const pill = screen.getByTestId("connection-status-pill");
      expect(pill.dataset.state).toBe(variant.state);
      expect(pill).toHaveTextContent(variant.label);
      expect(pill.className).toContain(variant.wrapToken);
    });
  }

  it("renders a distinct icon per variant so greyscale / colour-blind users can still distinguish them", () => {
    const seenIconShapes = new Set<string>();
    for (const variant of VARIANTS) {
      const { unmount } = render(
        <ConnectionStatusPill status={{ state: variant.state, checkedAt: FIXED_CHECKED_AT }} />,
      );
      const pill = screen.getByTestId("connection-status-pill");
      const svg = pill.querySelector("svg");
      if (!svg) throw new Error(`no <svg> rendered for ${variant.state}`);
      // lucide-react renders each icon with a unique `class` token "lucide-<name>"
      const lucideClass = Array.from(svg.classList).find((c) => c.startsWith("lucide-"));
      if (!lucideClass) throw new Error(`no lucide- class on <svg> for ${variant.state}`);
      seenIconShapes.add(lucideClass);
      unmount();
    }
    // Five variants must yield five distinct icon shapes.
    expect(seenIconShapes.size).toBe(VARIANTS.length);
  });
});

describe("ConnectionStatusPill: WCAG 2.1 AA contrast (TC-142, NFR-016)", () => {
  // Tailwind v4 default palette (sRGB). emerald-500/#00bc7d and emerald-50/#ecfdf5
  // are the exact values axe-core resolved on the plugin grid when it flagged the
  // 'Connected' pill at 2.34:1 (issue #448). At 12px/normal these pills are not
  // WCAG "large text", so the 4.5:1 threshold applies to every variant.
  const TAILWIND_HEX: Record<string, string> = {
    "emerald-50": "#ecfdf5",
    "emerald-700": "#007a55",
    "amber-500": "#fe9a00",
    "amber-950": "#461901",
    "red-50": "#fef2f2",
    "red-700": "#c10007",
    "stone-200": "#e7e5e4",
    "stone-300": "#d6d3d1",
    "stone-400": "#a6a09b",
    "stone-600": "#57534d",
    "stone-700": "#44403b",
    "stone-800": "#292524",
  };

  function relativeLuminance(hex: string): number {
    const n = hex.replace("#", "");
    const toLinear = (i: number) => {
      const c = parseInt(n.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const r = toLinear(0);
    const g = toLinear(2);
    const b = toLinear(4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(fgToken: string, bgToken: string): number {
    const fg = TAILWIND_HEX[fgToken];
    const bg = TAILWIND_HEX[bgToken];
    if (!fg) throw new Error(`unknown Tailwind colour token: ${fgToken}`);
    if (!bg) throw new Error(`unknown Tailwind colour token: ${bgToken}`);
    const hi = Math.max(relativeLuminance(fg), relativeLuminance(bg));
    const lo = Math.min(relativeLuminance(fg), relativeLuminance(bg));
    return (hi + 0.05) / (lo + 0.05);
  }

  // Extract the fg/bg colour tokens from a rendered pill's class string for each
  // theme it supports: the unprefixed pair (light) and any `dark:` pair (dark).
  // The size token `text-[12px]` is deliberately not matched by these regexes.
  function colourPairs(className: string): Array<{ theme: string; fg: string; bg: string }> {
    const tokens = className.split(/\s+/);
    const pick = (re: RegExp): string | undefined => {
      for (const t of tokens) {
        const m = t.match(re);
        if (m) return m[1];
      }
      return undefined;
    };
    const lightBg = pick(/^bg-([a-z]+-\d+)$/);
    const lightFg = pick(/^text-([a-z]+-\d+)$/);
    const darkBg = pick(/^dark:bg-([a-z]+-\d+)$/);
    const darkFg = pick(/^dark:text-([a-z]+-\d+)$/);
    const pairs: Array<{ theme: string; fg: string; bg: string }> = [];
    if (lightFg && lightBg) pairs.push({ theme: "light", fg: lightFg, bg: lightBg });
    if (darkFg && darkBg) pairs.push({ theme: "dark", fg: darkFg, bg: darkBg });
    return pairs;
  }

  for (const variant of VARIANTS) {
    it(`renders the ${variant.state} variant at >= 4.5:1 contrast in every theme it supports`, () => {
      render(
        <ConnectionStatusPill status={{ state: variant.state, checkedAt: FIXED_CHECKED_AT }} />,
      );
      const pill = screen.getByTestId("connection-status-pill");
      const pairs = colourPairs(pill.className);
      expect(pairs.length).toBeGreaterThan(0);
      for (const { theme, fg, bg } of pairs) {
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `${variant.state} (${theme}): ${fg} on ${bg} = ${ratio.toFixed(2)}:1 must clear WCAG AA`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

describe("ConnectionStatusPill: timestamp behaviour", () => {
  it("renders the checkedAt timestamp as 'as of HH:MM' on non-disabled variants", () => {
    render(<ConnectionStatusPill status={{ state: "connected", checkedAt: FIXED_CHECKED_AT }} />);
    expect(screen.getByTestId("connection-status-pill-timestamp")).toHaveTextContent("as of 09:07");
  });

  it("omits the timestamp entirely on the disabled variant (mockups §21)", () => {
    render(<ConnectionStatusPill status={{ state: "disabled", checkedAt: FIXED_CHECKED_AT }} />);
    expect(screen.queryByTestId("connection-status-pill-timestamp")).toBeNull();
  });

  it("omits the timestamp when checkedAt is not provided", () => {
    render(<ConnectionStatusPill status={{ state: "connected" }} />);
    expect(screen.queryByTestId("connection-status-pill-timestamp")).toBeNull();
  });
});

describe("ConnectionStatusPill: rechecking state (TC-111)", () => {
  it("replaces the timestamp with a pulsing 'rechecking...' when rechecking is true", () => {
    render(
      <ConnectionStatusPill
        status={{ state: "connected", checkedAt: FIXED_CHECKED_AT }}
        rechecking
      />,
    );
    const ts = screen.getByTestId("connection-status-pill-timestamp");
    expect(ts).toHaveTextContent("rechecking...");
    expect(ts.className).toContain("animate-pulse");
  });

  it("never enters the rechecking state on the disabled variant", () => {
    render(<ConnectionStatusPill status={{ state: "disabled" }} rechecking />);
    // disabled never carries a timestamp, and that holds even with rechecking=true
    expect(screen.queryByTestId("connection-status-pill-timestamp")).toBeNull();
  });
});

describe("ConnectionStatusPill: tooltip surfaces detail (TC-109)", () => {
  it("attaches an accessible name combining label + detail on auth-problem", async () => {
    render(
      <ConnectionStatusPill
        status={{
          state: "auth-problem",
          detail: "Token expired 2 hours ago. Click Configure to sign in again.",
          checkedAt: FIXED_CHECKED_AT,
        }}
      />,
    );
    const trigger = screen.getByTestId("connection-status-pill");
    expect(trigger.getAttribute("aria-label")).toContain("Sign in again");
    expect(trigger.getAttribute("aria-label")).toContain("Token expired 2 hours ago");
  });

  it("attaches an accessible name combining label + detail on errored", () => {
    render(
      <ConnectionStatusPill
        status={{
          state: "errored",
          detail: "Rate-limited until 14:42 UTC. Cut list shows last-known data.",
          checkedAt: FIXED_CHECKED_AT,
        }}
      />,
    );
    const trigger = screen.getByTestId("connection-status-pill");
    expect(trigger.getAttribute("aria-label")).toContain("Rate-limited until 14:42 UTC");
  });

  it("renders the tooltip content when the trigger receives keyboard focus", async () => {
    const user = userEvent.setup();
    render(
      <ConnectionStatusPill
        status={{
          state: "errored",
          detail: "Rate-limited until 14:42 UTC.",
          checkedAt: FIXED_CHECKED_AT,
        }}
      />,
    );
    await user.tab();
    const tooltip = await screen.findByTestId("connection-status-pill-tooltip");
    expect(tooltip).toHaveTextContent("Rate-limited until 14:42 UTC.");
  });

  it("does NOT render the tooltip wrapper on connected / disconnected / disabled", () => {
    for (const state of ["connected", "disconnected", "disabled"] as const) {
      const { unmount } = render(
        <ConnectionStatusPill status={{ state, detail: "ignored", checkedAt: FIXED_CHECKED_AT }} />,
      );
      const pill = screen.getByTestId("connection-status-pill");
      // The non-tooltip path renders a plain <span>, not a <button>.
      expect(pill.tagName.toLowerCase()).toBe("span");
      unmount();
    }
  });

  it("does NOT render the tooltip wrapper when detail is missing on auth-problem / errored", () => {
    for (const state of ["auth-problem", "errored"] as const) {
      const { unmount } = render(
        <ConnectionStatusPill status={{ state, checkedAt: FIXED_CHECKED_AT }} />,
      );
      const pill = screen.getByTestId("connection-status-pill");
      expect(pill.tagName.toLowerCase()).toBe("span");
      unmount();
    }
  });
});
