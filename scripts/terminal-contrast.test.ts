import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DESIGN_PATH, designColors } from "./semantic-dark-guard.mjs";

// The terminal ANSI roles (issue #1323) are the hues program output chooses, on
// the terminal's own ground, so each must clear WCAG AA for normal text on
// `terminal-ground` in the theme it belongs to. DESIGN.md records that claim in
// prose, and this is what holds a later hue or ground edit to it.
//
// Two entries sit next to the ground by definition and are excluded: black in
// dark, and bright white in light. Their twins in the other theme are measured
// like any other role.
const AA_NORMAL = 4.5;
const GROUND_ADJACENT = new Set(["terminal-ansi-black-dark", "terminal-ansi-bright-white"]);

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
const ansiRoles = Object.keys(colors)
  .filter((key) => key.startsWith("terminal-ansi-") && !key.endsWith("-dark"))
  .sort();

describe("DESIGN.md terminal colour roles", () => {
  it("records the sixteen ANSI roles", () => {
    expect(ansiRoles).toHaveLength(16);
  });

  it("puts the terminal on the app ground in both themes", () => {
    expect(colors["terminal-ground"].hex).toBe(colors["bg-base"].hex);
    expect(colors["terminal-ground-dark"].hex).toBe(colors["bg-base-dark"].hex);
  });

  describe.each(ansiRoles)("%s", (role) => {
    it("is opaque in both themes", () => {
      expect(colors[role].alpha).toBeUndefined();
      expect(colors[`${role}-dark`]?.alpha).toBeUndefined();
    });

    it(`clears ${AA_NORMAL}:1 on the light ground, unless it is the ground-adjacent entry`, () => {
      const measured = contrast(colors[role].hex, colors["terminal-ground"].hex);
      if (GROUND_ADJACENT.has(role)) {
        expect(measured).toBeLessThan(AA_NORMAL);
      } else {
        expect(measured).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });

    it(`clears ${AA_NORMAL}:1 on the dark ground, unless it is the ground-adjacent entry`, () => {
      const dark = colors[`${role}-dark`];
      expect(dark, `${role}-dark is missing`).toBeDefined();
      const measured = contrast(dark.hex, colors["terminal-ground-dark"].hex);
      if (GROUND_ADJACENT.has(`${role}-dark`)) {
        expect(measured).toBeLessThan(AA_NORMAL);
      } else {
        expect(measured).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    });
  });

  it("measures the terminal text tone against its ground too", () => {
    expect(
      contrast(colors["terminal-text"].hex, colors["terminal-ground"].hex),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
    expect(
      contrast(colors["terminal-text-dark"].hex, colors["terminal-ground-dark"].hex),
    ).toBeGreaterThanOrEqual(AA_NORMAL);
  });
});
