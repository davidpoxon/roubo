#!/usr/bin/env node
// DesignTokenGuard (issue #1297). DESIGN.md records colour as roles, not
// shades: the client paints with a semantic utility (`text-text-secondary`,
// `bg-bg-surface`, `border-danger-border`) and `design-tokens/semantic-dark.css`
// switches every role for dark mode, so a call site never names a palette shade
// and never carries a `dark:` pair. Nothing enforced that. The muted-text
// regression (164 light-only `text-stone-500` uses at 3.65:1 in dark) passed
// every gate because no gate looked at colour at all.
//
// Two rules, over every tracked `.ts`, `.tsx`, and `.css` file in `client/src`,
// plus `client/index.html`, whose `<body>` classes paint the ground before
// React mounts and sat outside the gate until the end of #1293:
//
//   1. Raw palette colour. A colour utility naming a Tailwind palette shade,
//      under any utility prefix (`bg-`, `text-`, `border-`, `border-t-`,
//      `ring-`, `ring-offset-`, `outline-`, `divide-`, `placeholder-`,
//      `shadow-`, `fill-`, `stroke-`, `from-`, `via-`, `to-`, `accent-`,
//      `caret-`, `decoration-`, ...) and any variant chain (`hover:`,
//      `data-[selected]:`, `group-hover/item:`), with or without an opacity
//      modifier: `text-stone-500`, `hover:bg-amber-500/15`. A shade names no
//      token, so it cannot follow the theme or a DESIGN.md change.
//
//   2. `dark:` colour variant. A colour utility behind a `dark:` variant,
//      whatever colour it names: a palette shade, `black` or `white`, an
//      arbitrary colour, or even a semantic token. The semantic layer already
//      switches with the theme, so any `dark:` colour pair is either a raw
//      shade in disguise or redundant.
//
// The guard skips the paths listed in `scripts/design-token-allowlist.json`,
// which held the directories and files still unmigrated while the colour
// migration (#1293) was in flight. That migration is complete and the list is
// empty, so every file under `client/src` is gated. A directory entry would
// cover everything beneath it and a file entry one file. The list only
// shrinks: an entry that no longer covers any violation fails as stale, and
// entries that overlap, or that name a path outside `client/src`, fail too.
// Keep it empty rather than adding an entry to get a violation past the gate.
//
// The check reads committed files only, so it needs no install and no network,
// and rides in the existing `lint` job.
//
// Run with: npm run lint:design-tokens

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const SCAN_ROOT = "client/src";
export const ALLOWLIST_PATH = "scripts/design-token-allowlist.json";
const EXTENSIONS = [".ts", ".tsx", ".css"];
// Files outside the scan root that still paint the client.
export const EXTRA_FILES = ["client/index.html"];

// Every Tailwind palette family. Stone, amber, red, and green are the ones
// DESIGN.md's roles resolve to, the categorical hues back the issue, agent, and
// project-status tokens, and the rest (including the cool neutrals DESIGN.md
// forbids outright) are no more acceptable as raw shades.
export const PALETTE_FAMILIES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
];

const SHADES = "50|100|200|300|400|500|600|700|800|900|950";

// Colour-taking utility prefixes. Longer prefixes come first so the regex
// alternation prefers `ring-offset` over `ring` and `border-t` over `border`.
const COLOUR_PREFIXES = [
  "inset-shadow",
  "inset-ring",
  "ring-offset",
  "placeholder",
  "decoration",
  "outline",
  "divide",
  "shadow",
  "accent",
  "stroke",
  "border-x",
  "border-y",
  "border-t",
  "border-r",
  "border-b",
  "border-l",
  "border-s",
  "border-e",
  "border",
  "caret",
  "ring",
  "fill",
  "text",
  "from",
  "via",
  "bg",
  "to",
];

// One variant in a chain: `hover:`, `data-[selected]:`, `group-hover/item:`,
// `[&>svg]:`, `aria-[invalid=true]:`.
const VARIANT = String.raw`(?:[\w-]+(?:\[[^\]\s]*\])?(?:\/[\w-]+)?:|\[[^\]\s]+\]:)`;

// A whole utility: an optional variant chain, an optional `!` important
// marker, a colour prefix, and the value after it. The lookbehind anchors the
// match at the start of a class token, so `bg-bg-surface` is not read as
// `bg-surface` preceded by a stray `bg-`.
const UTILITY = new RegExp(
  String.raw`(?<![\w\-:\[\]\/.!])(${VARIANT}*)!?(${COLOUR_PREFIXES.join("|")})-([\w\-\[\]#().,%\/]+)`,
  "g",
);

const PALETTE_VALUE = new RegExp(
  String.raw`^(?:${PALETTE_FAMILIES.join("|")})-(?:${SHADES})(?:\/|$)`,
);

// Colour values that are not palette shades but still paint a colour, for the
// `dark:` rule: the named keywords and arbitrary colour values.
const KEYWORD_COLOUR = /^(?:black|white|transparent|current|inherit)(?:\/|$)/;
const ARBITRARY_COLOUR = /^\[(?:#|rgb|hsl|oklch|oklab|lab|lch|hwb|color|var\(--color-)/;

/**
 * Whether a variant chain contains `dark:` as one of its variants.
 *
 * @param {string} chain - e.g. `dark:hover:`.
 * @returns {boolean}
 */
function hasDarkVariant(chain) {
  return /(?:^|:)dark:/.test(chain);
}

/**
 * Whether a utility value names a colour from the theme's own colour tokens.
 *
 * @param {string} value
 * @param {Set<string>} tokenNames
 * @returns {boolean}
 */
function isTokenColour(value, tokenNames) {
  const name = value.split("/")[0];
  return tokenNames.has(name);
}

/**
 * Scan one file's contents for design-token violations.
 *
 * Pure over its inputs so the test can drive it with in-memory fixtures.
 *
 * @param {string} contents
 * @param {Set<string>} tokenNames - semantic colour names (`bg-surface`,
 *   `text-secondary`), so a `dark:` pair on a token is recognised as colour.
 * @returns {{ line: number, utility: string, rule: "raw-palette" | "dark-variant" }[]}
 */
export function scanSource(contents, tokenNames = new Set()) {
  const findings = [];
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(UTILITY)) {
      const [utility, chain, , value] = match;
      const isPalette = PALETTE_VALUE.test(value);
      const isDark = hasDarkVariant(chain);
      if (isDark) {
        if (
          isPalette ||
          KEYWORD_COLOUR.test(value) ||
          ARBITRARY_COLOUR.test(value) ||
          isTokenColour(value, tokenNames)
        ) {
          findings.push({ line: i + 1, utility, rule: "dark-variant" });
        }
      } else if (isPalette) {
        findings.push({ line: i + 1, utility, rule: "raw-palette" });
      }
    }
  }
  return findings;
}

/**
 * The semantic colour names the theme defines, read from every `--color-*`
 * declaration in the given stylesheets.
 *
 * @param {string[]} stylesheets
 * @returns {Set<string>}
 */
export function colourTokenNames(stylesheets) {
  const names = new Set();
  for (const css of stylesheets) {
    for (const m of css.matchAll(/--color-([\w-]+)\s*:/g)) names.add(m[1]);
  }
  return names;
}

/**
 * Whether an allowlist entry covers a file. A directory entry ends in `/` and
 * covers everything beneath it; a file entry covers only that file.
 *
 * @param {string} entry
 * @param {string} file
 * @returns {boolean}
 */
function covers(entry, file) {
  return entry.endsWith("/") ? file.startsWith(entry) : file === entry;
}

/**
 * Apply the allowlist to per-file findings.
 *
 * @param {Record<string, { line: number, utility: string, rule: string }[]>} findingsByFile
 *   every scanned file, including clean ones (an empty array).
 * @param {string[]} allowlist
 * @returns {{
 *   violations: { file: string, line: number, utility: string, rule: string }[],
 *   problems: { entry: string, reason: string }[],
 * }}
 */
export function applyAllowlist(findingsByFile, allowlist) {
  const violations = [];
  const problems = [];

  const seen = new Set();
  for (const entry of allowlist) {
    if (seen.has(entry)) {
      problems.push({ entry, reason: "listed more than once." });
      continue;
    }
    seen.add(entry);
    if (!entry.startsWith(`${SCAN_ROOT}/`)) {
      problems.push({
        entry,
        reason: `outside ${SCAN_ROOT}/; only paths under it can be allowlisted.`,
      });
      continue;
    }
    const parent = allowlist.find(
      (other) => other !== entry && other.endsWith("/") && entry.startsWith(other),
    );
    if (parent) {
      problems.push({ entry, reason: `already covered by the directory entry ${parent}.` });
    }
  }

  const covering = new Map(allowlist.map((entry) => [entry, 0]));
  for (const [file, findings] of Object.entries(findingsByFile)) {
    const entry = allowlist.find((e) => covers(e, file));
    if (entry) {
      covering.set(entry, covering.get(entry) + findings.length);
      continue;
    }
    for (const f of findings) violations.push({ file, ...f });
  }

  for (const [entry, count] of covering) {
    if (count === 0 && !problems.some((p) => p.entry === entry)) {
      problems.push({
        entry,
        reason:
          "stale: it no longer covers any violation. Remove it, so the migrated " +
          "path stays migrated.",
      });
    }
  }

  return { violations, problems };
}

/**
 * The tracked files the guard scans.
 *
 * @returns {string[]}
 */
export function listFiles() {
  const output = execSync(`git ls-files ${SCAN_ROOT}`, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\n")
    .filter(Boolean)
    .filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)))
    .filter((f) => !f.endsWith(".d.ts"))
    .concat(EXTRA_FILES);
}

/**
 * Scan every tracked file the guard covers.
 *
 * @returns {Record<string, { line: number, utility: string, rule: string }[]>}
 */
export function scanTree() {
  const tokenNames = colourTokenNames([readFileSync("design-tokens/tokens.tailwind.css", "utf8")]);
  const findingsByFile = {};
  for (const file of listFiles()) {
    findingsByFile[file] = scanSource(readFileSync(file, "utf8"), tokenNames);
  }
  return findingsByFile;
}

// Only run the CLI when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")).entries ?? [];
  const { violations, problems } = applyAllowlist(scanTree(), allowlist);

  if (violations.length > 0) {
    console.error(
      `Found ${violations.length} design-token violation(s). Paint with a semantic ` +
        "role utility (`text-text-secondary`, `bg-bg-surface`), never a raw palette " +
        "shade or a `dark:` pair; semantic-dark.css already switches every role for " +
        "dark mode. See DESIGN.md and docs/development.md.\n",
    );
    for (const v of violations) {
      const why =
        v.rule === "dark-variant"
          ? "`dark:` colour variant"
          : "raw palette colour, which names no token";
      console.error(`  ${v.file}:${v.line}  ${v.utility}  (${why})`);
    }
  }

  if (problems.length > 0) {
    if (violations.length > 0) console.error("");
    console.error(`Found ${problems.length} problem(s) in ${ALLOWLIST_PATH}:\n`);
    for (const p of problems) console.error(`  ${p.entry}: ${p.reason}`);
  }

  if (violations.length > 0 || problems.length > 0) process.exit(1);

  console.log(
    `No design-token violations found outside the ${allowlist.length} allowlisted ` +
      `path(s) in ${ALLOWLIST_PATH}.`,
  );
}
