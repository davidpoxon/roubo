import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DESIGN_PATH,
  SEMANTIC_DARK_PATH,
  darkPairedRoles,
  declaredRedirects,
  missingRedirects,
} from "./semantic-dark-guard.mjs";

// A DESIGN.md reduced to what the guard reads: the marker comment and the
// fenced token block after it.
function design(colors: Record<string, unknown>): string {
  return [
    "# Design",
    "",
    "## Tokens (machine-checkable)",
    "",
    "<!-- ui-design:tokens v4 -->",
    "",
    "```json",
    JSON.stringify({ schema_version: 4, colors }),
    "```",
    "",
  ].join("\n");
}

const COLORS = {
  "bg-base": { hex: "#FAFAF9" },
  "bg-base-dark": { hex: "#0C0A09" },
  "text-body": { hex: "#44403C" },
  "text-body-dark": { hex: "#D6D3D1" },
  accent: { hex: "#F59E0B" },
};

describe("darkPairedRoles (SemanticDarkGuard)", () => {
  it("returns the base name of every -dark colour key, and ignores unpaired keys", () => {
    expect(darkPairedRoles(design(COLORS))).toEqual(["bg-base", "text-body"]);
  });

  it("throws when the token block is missing, rather than passing vacuously", () => {
    expect(() => darkPairedRoles("# Design\n\nNo tokens here.\n")).toThrow(/token block/);
  });

  it("throws when the token block is not valid JSON", () => {
    const broken = "<!-- ui-design:tokens v4 -->\n```json\n{ colors: \n```\n";
    expect(() => darkPairedRoles(broken)).toThrow(/not valid JSON/);
  });

  it("throws when the token block has no colors object", () => {
    const noColors = '<!-- ui-design:tokens v4 -->\n```json\n{"schema_version": 4}\n```\n';
    expect(() => darkPairedRoles(noColors)).toThrow(/no `colors` object/);
  });
});

describe("declaredRedirects (SemanticDarkGuard)", () => {
  it("counts only redirects to the role's own -dark sibling inside .dark", () => {
    const css = [
      "/* --color-commented: var(--color-commented-dark); */",
      ":root { --color-outside: var(--color-outside-dark); }",
      ".dark {",
      "  --color-bg-base: var(--color-bg-base-dark);",
      "  --color-text-body: var(--color-bg-base-dark);",
      "}",
    ].join("\n");
    expect([...declaredRedirects(css)]).toEqual(["bg-base"]);
  });
});

describe("missingRedirects (SemanticDarkGuard)", () => {
  it("passes when every -dark colour has its theme switch", () => {
    const css = [
      ".dark {",
      "  --color-bg-base: var(--color-bg-base-dark);",
      "  --color-text-body: var(--color-text-body-dark);",
      "}",
    ].join("\n");
    expect(missingRedirects(design(COLORS), css)).toEqual([]);
  });

  it("flags a -dark colour DESIGN.md records that semantic-dark.css never switches", () => {
    // The regression this guard exists for: a new dark pair lands in DESIGN.md
    // and the build still compiles, rendering the light value in dark mode.
    const css = ".dark {\n  --color-bg-base: var(--color-bg-base-dark);\n}\n";
    expect(missingRedirects(design(COLORS), css)).toEqual(["text-body"]);
  });

  it("passes the committed DESIGN.md and semantic-dark.css", () => {
    const missing = missingRedirects(
      readFileSync(DESIGN_PATH, "utf8"),
      readFileSync(SEMANTIC_DARK_PATH, "utf8"),
    );
    expect(missing).toEqual([]);
  });
});
