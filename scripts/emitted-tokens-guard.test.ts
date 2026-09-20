import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DESIGN_PATH,
  TAILWIND_PATH,
  alphaSuffix,
  designTokens,
  flattenTokens,
  formatReport,
  normalizeHex,
  themeDeclarations,
  tokenMismatches,
} from "./emitted-tokens-guard.mjs";

// A DESIGN.md reduced to what the guard reads: the marker comment and the
// fenced token block after it.
function design(tokens: Record<string, unknown>): string {
  return [
    "# Design",
    "",
    "## Tokens (machine-checkable)",
    "",
    "<!-- ui-design:tokens v4 -->",
    "",
    "```json",
    JSON.stringify({ schema_version: 4, ...tokens }),
    "```",
    "",
  ].join("\n");
}

// A tokens.tailwind.css reduced to what the guard reads: the managed-region
// sentinels and the one `@theme` block between them.
function tailwind(lines: string[]): string {
  return [
    "/* ui-design:tokens:start v4 - managed by emit_tokens.py; edits here are overwritten */",
    "@theme {",
    ...lines.map((line) => `  ${line}`),
    "}",
    "/* ui-design:tokens:end */",
    "",
  ].join("\n");
}

const COLORS = {
  accent: { hex: "#F59E0B", role: "primary" },
  "accent-border": { hex: "#F59E0B", role: "border-accent", alpha: 0.4 },
  "bg-base": { hex: "#FAFAF9", role: "surface" },
};

const EMITTED = [
  "--color-accent: #F59E0B;",
  "--color-accent-border: #F59E0B66;",
  "--color-bg-base: #FAFAF9;",
];

describe("designTokens (EmittedTokensGuard)", () => {
  it("returns the parsed token block", () => {
    expect(designTokens(design({ colors: COLORS }))).toMatchObject({ colors: COLORS });
  });

  it("throws when the token block is missing, rather than passing vacuously", () => {
    expect(() => designTokens("# Design\n\nNo tokens here.\n")).toThrow(/token block/);
  });

  it("throws when the token block is not valid JSON", () => {
    const broken = "<!-- ui-design:tokens v4 -->\n```json\n{ colors: \n```\n";
    expect(() => designTokens(broken)).toThrow(/not valid JSON/);
  });

  it("throws when the token block is not a JSON object", () => {
    const array = "<!-- ui-design:tokens v4 -->\n```json\n[]\n```\n";
    expect(() => designTokens(array)).toThrow(/not a JSON object/);
  });
});

describe("normalizeHex (EmittedTokensGuard)", () => {
  it("expands a three digit hex and uppercases, as the emitter does", () => {
    expect(normalizeHex("#abc")).toBe("#AABBCC");
    expect(normalizeHex("#f59e0b")).toBe("#F59E0B");
  });

  it("returns null for anything that is not a hex colour", () => {
    for (const value of ["red", "#ABCD", "", "rgb(0 0 0)", 42, null, undefined]) {
      expect(normalizeHex(value)).toBeNull();
    }
  });
});

describe("alphaSuffix (EmittedTokensGuard)", () => {
  // The round trip that makes an alpha value checkable at all: emit_tokens.py
  // bakes the recorded alpha into the 8 digit hex, so the guard has to produce
  // the same byte or every alpha colour reads as a mismatch.
  it.each([
    [0, "00"],
    [0.15, "26"],
    [0.2, "33"],
    [0.4, "66"],
    [0.5, "80"],
    [0.6, "99"],
    [1, "FF"],
  ])("renders alpha %s as the hex byte %s", (alpha, byte) => {
    expect(alphaSuffix(alpha)).toBe(byte);
  });

  // The emitter rounds with Python's `round`, which breaks a tie to the even
  // neighbour. These are the only two recordable alphas that land on a tie
  // with an even floor, so they are the only two where rounding upward would
  // fail a correctly regenerated file.
  it.each([
    [0.3, "4C"],
    [0.7, "B2"],
  ])("breaks the tie at alpha %s downward, as the emitter does", (alpha, byte) => {
    expect(alphaSuffix(alpha)).toBe(byte);
  });

  it("renders no suffix when there is no usable alpha", () => {
    for (const alpha of [undefined, null, "0.4", true, false, -0.1, 1.5, NaN, Infinity]) {
      expect(alphaSuffix(alpha)).toBe("");
    }
  });
});

describe("flattenTokens (EmittedTokensGuard)", () => {
  it("emits colours key-sorted, with the alpha baked into an 8 digit hex", () => {
    expect(flattenTokens({ colors: COLORS })).toEqual([
      { name: "--color-accent", value: "#F59E0B" },
      { name: "--color-accent-border", value: "#F59E0B66" },
      { name: "--color-bg-base", value: "#FAFAF9" },
    ]);
  });

  it("skips a colour with no hex, because the emitter never writes one", () => {
    const colors = { ...COLORS, ghost: { role: "surface" }, absent: { hex: null } };
    const names = flattenTokens({ colors }).map((pair) => pair.name);
    expect(names).not.toContain("--color-ghost");
    expect(names).not.toContain("--color-absent");
  });

  it("passes a non-hex colour through verbatim, and drops its alpha", () => {
    const colors = { named: { hex: "rebeccapurple", alpha: 0.4 } };
    expect(flattenTokens({ colors })).toEqual([{ name: "--color-named", value: "rebeccapurple" }]);
  });

  it("suffixes a bare numeric length with px and leaves raw values alone", () => {
    const tokens = {
      type: {
        family: '"IBM Plex Sans", system-ui, sans-serif',
        scale: [11, 16.0],
        weights: [400, 700],
      },
      spacing: [1, 4],
      radius: [4, 9999],
      elevation: ["0 8px 24px -6px rgb(28 25 23 / 0.16)"],
      motion: {
        primitives: {
          durations: { standard: "200ms", fast: "150ms" },
          easings: { standard: "cubic-bezier(0.2, 0, 0, 1)" },
        },
      },
    };
    expect(flattenTokens(tokens)).toEqual([
      { name: "--type-family", value: '"IBM Plex Sans", system-ui, sans-serif' },
      { name: "--type-scale-0", value: "11px" },
      { name: "--type-scale-1", value: "16px" },
      { name: "--type-weights-0", value: "400" },
      { name: "--type-weights-1", value: "700" },
      { name: "--space-0", value: "1px" },
      { name: "--space-1", value: "4px" },
      { name: "--radius-0", value: "4px" },
      { name: "--radius-1", value: "9999px" },
      { name: "--elevation-0", value: "0 8px 24px -6px rgb(28 25 23 / 0.16)" },
      { name: "--motion-duration-fast", value: "150ms" },
      { name: "--motion-duration-standard", value: "200ms" },
      { name: "--motion-easing-standard", value: "cubic-bezier(0.2, 0, 0, 1)" },
    ]);
  });

  it("resolves a layout gutter through the spacing scale, and omits it when it misses", () => {
    const spacing = [1, 2, 4, 6, 8, 12, 14];
    expect(flattenTokens({ spacing, layout: { gutter: "space.6" } })).toContainEqual({
      name: "--layout-gutter",
      value: "14px",
    });
    const names = flattenTokens({ spacing, layout: { gutter: "space.99" } }).map((p) => p.name);
    expect(names).not.toContain("--layout-gutter");
  });

  it("emits the layout content max and containers as key-sorted lengths", () => {
    // css_slug replaces dots only, so the underscore in `content_max` survives
    // into the custom property name.
    const layout = { content_max: 1200, containers: { wide: 1440, narrow: 720 } };
    expect(flattenTokens({ layout })).toEqual([
      { name: "--layout-content_max", value: "1200px" },
      { name: "--layout-containers-narrow", value: "720px" },
      { name: "--layout-containers-wide", value: "1440px" },
    ]);
  });

  it("ignores the keys DESIGN.md records that the emitter never writes", () => {
    const tokens = {
      elevation_dark: ["0 24px 48px -12px rgb(0 0 0 / 0.7)"],
      border_width: { hairline: 1 },
      opacity: { disabled: 0.4 },
      type: { line_height: [1.45], letter_spacing: ["0.12em"], fonts: { mono: {} } },
    };
    expect(flattenTokens(tokens)).toEqual([]);
  });
});

describe("themeDeclarations (EmittedTokensGuard)", () => {
  it("reads only the declarations inside the @theme block", () => {
    const css = [
      ":root { --color-outside: #000000; }",
      "@theme {",
      "  --color-accent: #F59E0B;",
      "  --space-0: 1px;",
      "}",
    ].join("\n");
    expect([...themeDeclarations(css)]).toEqual([
      ["--color-accent", "#F59E0B"],
      ["--space-0", "1px"],
    ]);
  });

  it("throws when there is no @theme block, rather than passing vacuously", () => {
    expect(() => themeDeclarations(":root { --color-accent: #F59E0B; }\n")).toThrow(/@theme/);
  });
});

describe("tokenMismatches (EmittedTokensGuard)", () => {
  it("passes when DESIGN.md and the @theme block agree", () => {
    expect(tokenMismatches(design({ colors: COLORS }), tailwind(EMITTED))).toEqual({
      missing: [],
      extra: [],
      differing: [],
    });
  });

  it("flags a colour DESIGN.md records that the @theme block never emitted", () => {
    // The regression this guard exists for: a new role lands in DESIGN.md, the
    // regenerated @theme variable is not committed, and the utility that names
    // it compiles fine and paints nothing.
    const css = tailwind(EMITTED.filter((line) => !line.startsWith("--color-bg-base")));
    expect(tokenMismatches(design({ colors: COLORS }), css).missing).toEqual([
      { name: "--color-bg-base", expected: "#FAFAF9" },
    ]);
  });

  it("flags a token the @theme block emits that DESIGN.md no longer records", () => {
    const css = tailwind([...EMITTED, "--color-legacy-pill-bg: #E7E5E4;"]);
    expect(tokenMismatches(design({ colors: COLORS }), css).extra).toEqual([
      { name: "--color-legacy-pill-bg", emitted: "#E7E5E4" },
    ]);
  });

  it("flags a value that differs only by its alpha byte", () => {
    const css = tailwind(
      EMITTED.map((line) =>
        line.startsWith("--color-accent-border") ? "--color-accent-border: #F59E0B33;" : line,
      ),
    );
    expect(tokenMismatches(design({ colors: COLORS }), css).differing).toEqual([
      { name: "--color-accent-border", expected: "#F59E0B66", emitted: "#F59E0B33" },
    ]);
  });

  it("flags a non-colour value that drifted, not just colours", () => {
    const tokens = { colors: {}, radius: [4, 6] };
    const css = tailwind(["--radius-0: 4px;", "--radius-1: 8px;"]);
    expect(tokenMismatches(design(tokens), css).differing).toEqual([
      { name: "--radius-1", expected: "6px", emitted: "8px" },
    ]);
  });

  it("passes the committed DESIGN.md and tokens.tailwind.css", () => {
    const mismatches = tokenMismatches(
      readFileSync(DESIGN_PATH, "utf8"),
      readFileSync(TAILWIND_PATH, "utf8"),
    );
    expect(mismatches).toEqual({ missing: [], extra: [], differing: [] });
  });
});

describe("formatReport (EmittedTokensGuard)", () => {
  it("reports nothing when there is nothing to report", () => {
    expect(formatReport({ missing: [], extra: [], differing: [] })).toBe("");
  });

  it("names every offending token and the line to add, remove or replace", () => {
    const report = formatReport({
      missing: [{ name: "--color-kind-component-surface", expected: "#F0FDFA" }],
      extra: [{ name: "--color-legacy-pill-bg", emitted: "#E7E5E4" }],
      differing: [{ name: "--radius-1", expected: "6px", emitted: "8px" }],
    });
    expect(report).toContain("disagree on 3 token(s)");
    expect(report).toContain("  --color-kind-component-surface: #F0FDFA;");
    expect(report).toContain("  --color-legacy-pill-bg: #E7E5E4;");
    expect(report).toContain("  --radius-1: 6px;   (currently 8px)");
    // Each direction says what to do with the lines under it.
    expect(report).toMatch(/does not emit\. Add inside `@theme`:/);
    expect(report).toMatch(/no longer records\. Remove from `@theme`:/);
    expect(report).toMatch(/value differs\. Replace the line in `@theme`:/);
  });
});
