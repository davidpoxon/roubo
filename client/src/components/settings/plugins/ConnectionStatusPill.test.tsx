// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  { state: "connected", label: "Connected", wrapToken: "bg-success-surface" },
  { state: "disconnected", label: "Not connected", wrapToken: "bg-bg-pressed" },
  { state: "auth-problem", label: "Sign in again", wrapToken: "bg-accent-muted" },
  { state: "errored", label: "Error", wrapToken: "bg-danger-surface" },
  { state: "disabled", label: "Disabled", wrapToken: "bg-bg-hover" },
];

describe("ConnectionStatusPill: five-variant taxonomy (IP-TC-108)", () => {
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

describe("ConnectionStatusPill: WCAG 2.1 AA contrast (IP-TC-142, IP-NFR-016)", () => {
  // The pill paints with DESIGN.md role utilities, so its colours are read from
  // the emitted token file rather than a hand-kept palette: each role's light
  // value is `--color-<role>` and its dark value `--color-<role>-dark` (the
  // switch semantic-dark.css makes under .dark). An alpha ground such as
  // accent-muted is composited over the card surface the pill sits on. At
  // 12px/normal these pills are not WCAG "large text", so the 4.5:1 threshold
  // applies to every variant in both themes (#921).
  const TOKENS_CSS = readFileSync(
    resolve(process.cwd(), "design-tokens/tokens.tailwind.css"),
    "utf8",
  );

  function tokenHex(role: string, theme: "light" | "dark"): string {
    const read = (name: string) =>
      TOKENS_CSS.match(new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6,8});`))?.[1];
    const hex = (theme === "dark" && read(`${role}-dark`)) || read(role);
    if (!hex) throw new Error(`unknown DESIGN.md colour role: ${role}`);
    return hex;
  }

  function rgba(hex: string): [number, number, number, number] {
    const n = hex.replace("#", "");
    const c = (i: number) => parseInt(n.slice(i, i + 2), 16);
    return [c(0), c(2), c(4), n.length === 8 ? c(6) / 255 : 1];
  }

  function composite(hex: string, under: string): [number, number, number] {
    const [r, g, b, a] = rgba(hex);
    const [ur, ug, ub] = rgba(under);
    return [r * a + ur * (1 - a), g * a + ug * (1 - a), b * a + ub * (1 - a)];
  }

  function relativeLuminance([r, g, b]: [number, number, number]): number {
    const toLinear = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }

  function contrastRatio(fgRole: string, bgRole: string, theme: "light" | "dark"): number {
    const surface = tokenHex("bg-surface", theme);
    const bg = composite(tokenHex(bgRole, theme), surface);
    const fg = composite(tokenHex(fgRole, theme), surface);
    const hi = Math.max(relativeLuminance(fg), relativeLuminance(bg));
    const lo = Math.min(relativeLuminance(fg), relativeLuminance(bg));
    return (hi + 0.05) / (lo + 0.05);
  }

  // The fg/bg role pair in a rendered pill's class string. The size token
  // `text-12` is deliberately not matched by the text regex.
  function colourPair(className: string): { fg: string; bg: string } | undefined {
    const tokens = className.split(/\s+/);
    const fg = tokens.map((t) => t.match(/^text-([a-z][a-z-]*)$/)?.[1]).find(Boolean);
    const bg = tokens.map((t) => t.match(/^bg-([a-z][a-z-]*)$/)?.[1]).find(Boolean);
    return fg && bg ? { fg, bg } : undefined;
  }

  for (const variant of VARIANTS) {
    it(`renders the ${variant.state} variant at >= 4.5:1 contrast in both themes`, () => {
      render(
        <ConnectionStatusPill status={{ state: variant.state, checkedAt: FIXED_CHECKED_AT }} />,
      );
      const pill = screen.getByTestId("connection-status-pill");
      const pair = colourPair(pill.className);
      expect(pair).toBeDefined();
      if (!pair) return;
      for (const theme of ["light", "dark"] as const) {
        const ratio = contrastRatio(pair.fg, pair.bg, theme);
        expect(
          ratio,
          `${variant.state} (${theme}): ${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}:1 must clear WCAG AA`,
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

describe("ConnectionStatusPill: rechecking state (IP-TC-111)", () => {
  it("replaces the timestamp with a pulsing 'rechecking...' when rechecking is true", () => {
    render(
      <ConnectionStatusPill
        status={{ state: "connected", checkedAt: FIXED_CHECKED_AT }}
        rechecking
      />,
    );
    const ts = screen.getByTestId("connection-status-pill-timestamp");
    expect(ts).toHaveTextContent("rechecking...");
    expect(ts.className).toContain("animate-status-pulse");
  });

  it("never enters the rechecking state on the disabled variant", () => {
    render(<ConnectionStatusPill status={{ state: "disabled" }} rechecking />);
    // disabled never carries a timestamp, and that holds even with rechecking=true
    expect(screen.queryByTestId("connection-status-pill-timestamp")).toBeNull();
  });
});

describe("ConnectionStatusPill: tooltip surfaces detail (IP-TC-109)", () => {
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
