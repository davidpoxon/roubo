import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DESIGN_PATH, designColors } from "./semantic-dark-guard.mjs";

// The code syntax roles (issue #1331) are text on the editor's input ground, so
// each must clear WCAG AA for normal text on `bg-field` in both themes. A
// syntax hue is the one categorical text colour that sits on a ground with no
// tint of its own, so nothing else in the contrast suites measures it.
const AA_NORMAL = 4.5;

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const colors = designColors(readFileSync(DESIGN_PATH, "utf8"));
const syntaxRoles = Object.keys(colors)
  .filter((key) => key.startsWith("syntax-") && !key.endsWith("-dark"))
  .sort();

describe("DESIGN.md code syntax roles", () => {
  it("records the key, string, and literal roles", () => {
    expect(syntaxRoles).toEqual(["syntax-key", "syntax-literal", "syntax-string"]);
  });

  describe.each(syntaxRoles)("%s", (role) => {
    it("is opaque in both themes", () => {
      expect(colors[role].alpha).toBeUndefined();
      expect(colors[`${role}-dark`]?.alpha).toBeUndefined();
    });

    it(`clears ${AA_NORMAL}:1 on bg-field in light`, () => {
      expect(contrast(colors[role].hex, colors["bg-field"].hex)).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    it(`clears ${AA_NORMAL}:1 on bg-field in dark`, () => {
      const dark = colors[`${role}-dark`];
      expect(dark, `${role}-dark is missing`).toBeDefined();
      expect(contrast(dark.hex, colors["bg-field-dark"].hex)).toBeGreaterThanOrEqual(AA_NORMAL);
    });
  });
});
