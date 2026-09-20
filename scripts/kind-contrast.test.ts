import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DESIGN_PATH, designColors } from "./semantic-dark-guard.mjs";

// The plugin kind pill roles (issue #1340) are the categorical set the other
// two contrast suites left uncovered. A pill is text on its own tinted ground
// inside a card, so each `-text` role must clear WCAG AA for normal text on the
// surface it sits on, and each `-border` must clear the 3:1 non-text bar
// against both colours it separates: the card ground outside and the pill
// surface inside.
//
// Two things here are not in the terminal or syntax suites. The dark surfaces
// are 20% tints, so the ground beneath them is part of the measurement and has
// to be composited in. And the figures DESIGN.md records in prose are read back
// out of the file and asserted, rather than only a floor, so a hex that moves a
// ratio fails here instead of drifting quietly inside the bar.
const AA_NORMAL = 4.5;
const NON_TEXT = 3;

// The card the pill sits in paints `bg-surface`, and `bg-hover` is the ground a
// card that washes on hover would put beneath it.
const GROUNDS = ["bg-surface", "bg-hover"] as const;
const KINDS = ["kind-agent", "kind-component", "kind-integration"] as const;
const THEMES = [
  ["light", ""],
  ["dark", "-dark"],
] as const;

type Token = { hex: string; role: string; alpha?: number };

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function luminance(channels: number[]): number {
  const [r, g, b] = channels
    .map((v) => v / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Source-over compositing, kept in float. Quantising the result back to an
// 8-bit hex first shifts several of the recorded figures in the last decimal,
// and the browser does not round here either.
function over(token: Token, ground: number[]): number[] {
  if (token.alpha === undefined) return rgb(token.hex);
  return rgb(token.hex).map((v, i) => v * token.alpha + ground[i] * (1 - token.alpha));
}

const design = readFileSync(DESIGN_PATH, "utf8");
const colors = designColors(design) as Record<string, Token>;

// The figures are read from the kind bullet alone. Its neighbours at
// DESIGN.md:61 and :63 record their own families the same way, in the same
// words, so a pattern loosed on the whole file would sooner or later measure
// kind roles against the issue chip's or the syntax string's number.
const KIND_BULLET = /^- \*\*Plugin kind pills\*\*.*$/m;

function kindBullet(): string {
  const match = KIND_BULLET.exec(design);
  if (!match) {
    throw new Error(`${DESIGN_PATH} no longer carries a "Plugin kind pills" bullet.`);
  }
  return match[0];
}

/** A `role at ratio:1` figure the kind bullet states, as the test reads it back. */
function recordedFigure(pattern: RegExp): { role: string; ratio: number } {
  const match = pattern.exec(kindBullet());
  if (!match) {
    throw new Error(
      `${DESIGN_PATH}'s plugin kind pill bullet no longer records the figure matched by ${pattern}`,
    );
  }
  return { role: match[1], ratio: Number(match[2]) };
}

type Measurement = { role: string; theme: string; ground: string; ratio: number };

const textPairs: Measurement[] = [];
const borderPairs: Measurement[] = [];

for (const kind of KINDS) {
  for (const [theme, suffix] of THEMES) {
    for (const ground of GROUNDS) {
      const beneath = rgb(colors[`${ground}${suffix}`].hex);
      const surface = over(colors[`${kind}-surface${suffix}`], beneath);
      textPairs.push({
        role: `${kind}-text`,
        theme,
        ground,
        ratio: contrast(rgb(colors[`${kind}-text${suffix}`].hex), surface),
      });
      const border = over(colors[`${kind}-border${suffix}`], beneath);
      // The weaker of the two edges is the one that decides whether the outline
      // reads as a boundary at all.
      borderPairs.push({
        role: `${kind}-border`,
        theme,
        ground,
        ratio: Math.min(contrast(border, beneath), contrast(border, surface)),
      });
    }
  }
}

const lowest = (rows: Measurement[]) => rows.reduce((a, b) => (b.ratio < a.ratio ? b : a));

// DESIGN.md is the source, but the app paints from the emitted custom
// properties, and that file is maintained by hand. Measuring DESIGN.md alone
// would stay green through an edit that never reached the CSS, shipping the
// old colour against a figure that describes the new one.
const EMITTED_PATH = "design-tokens/tokens.tailwind.css";
const emitted = readFileSync(EMITTED_PATH, "utf8");

/** The value DESIGN.md's token implies in the emitted file: hex, plus an alpha byte when tinted. */
function emittedValue(token: Token): string {
  if (token.alpha === undefined) return token.hex;
  const byte = Math.round(token.alpha * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `${token.hex}${byte}`;
}

describe("DESIGN.md plugin kind pill roles", () => {
  it("records a surface, border, and text role for each of the three kinds", () => {
    const kindRoles = Object.keys(colors)
      .filter((key) => key.startsWith("kind-") && !key.endsWith("-dark"))
      .sort();
    expect(kindRoles).toEqual([
      "kind-agent-border",
      "kind-agent-surface",
      "kind-agent-text",
      "kind-component-border",
      "kind-component-surface",
      "kind-component-text",
      "kind-integration-border",
      "kind-integration-surface",
      "kind-integration-text",
    ]);
  });

  describe.each(KINDS)("%s", (kind) => {
    it("keeps the text opaque and tints only the dark surface", () => {
      expect(colors[`${kind}-text`].alpha).toBeUndefined();
      expect(colors[`${kind}-text-dark`].alpha).toBeUndefined();
      expect(colors[`${kind}-surface`].alpha).toBeUndefined();
      expect(colors[`${kind}-surface-dark`].alpha).toBe(0.2);
    });

    // An outline that must be found is a line, not a wash, in either theme.
    it("draws the border as an opaque line in both themes", () => {
      expect(colors[`${kind}-border`].alpha).toBeUndefined();
      expect(colors[`${kind}-border-dark`].alpha).toBeUndefined();
    });

    it.each(["surface", "border", "text"])(
      `emits the measured %s value to ${EMITTED_PATH}`,
      (part) => {
        for (const suffix of ["", "-dark"]) {
          const role = `${kind}-${part}${suffix}`;
          expect(emitted, `${EMITTED_PATH} does not declare --color-${role}`).toContain(
            `  --color-${role}: ${emittedValue(colors[role])};\n`,
          );
        }
      },
    );

    describe.each(THEMES)("in %s", (theme) => {
      it.each(GROUNDS)(`clears ${AA_NORMAL}:1 for text over the %s ground`, (ground) => {
        const measured = textPairs.find(
          (row) => row.role === `${kind}-text` && row.theme === theme && row.ground === ground,
        );
        expect(measured?.ratio).toBeGreaterThanOrEqual(AA_NORMAL);
      });

      it.each(GROUNDS)(`clears ${NON_TEXT}:1 for the border over the %s ground`, (ground) => {
        const measured = borderPairs.find(
          (row) => row.role === `${kind}-border` && row.theme === theme && row.ground === ground,
        );
        expect(measured?.ratio).toBeGreaterThanOrEqual(NON_TEXT);
      });
    });
  });

  // These three hold DESIGN.md's prose to the token block. Move a hex without
  // rewriting the bullet and the figure, or the role named as lowest, stops
  // matching what the values actually measure.
  it("measures the lowest light text pair DESIGN.md names", () => {
    const recorded = recordedFigure(
      /lowest text pair is `([\w-]+)` at ([\d.]+):1 on its light surface/,
    );
    const measured = lowest(textPairs.filter((row) => row.theme === "light"));
    expect(measured.role).toBe(recorded.role);
    expect(measured.ratio).toBeCloseTo(recorded.ratio, 2);
  });

  it("measures the lowest dark text pair DESIGN.md names", () => {
    const recorded = recordedFigure(/`([\w-]+)` at ([\d.]+):1 over the dark hover ground/);
    const measured = lowest(textPairs.filter((row) => row.theme === "dark"));
    expect(measured.role).toBe(recorded.role);
    expect(measured.ground).toBe("bg-hover");
    expect(measured.ratio).toBeCloseTo(recorded.ratio, 2);
  });

  it("measures the lowest border DESIGN.md names", () => {
    const recorded = recordedFigure(/the lowest is `([\w-]+)` at ([\d.]+):1 in light/);
    const measured = lowest(borderPairs);
    expect(measured.role).toBe(recorded.role);
    expect(measured.theme).toBe("light");
    expect(measured.ratio).toBeCloseTo(recorded.ratio, 2);
  });
});
