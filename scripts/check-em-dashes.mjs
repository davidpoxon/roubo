#!/usr/bin/env node
// Repo-wide guard against em dashes (issue #371). CLAUDE.md forbids the em dash
// (U+2014) and its HTML entity (&mdash;) in code comments, commit messages, PR
// descriptions, README, docs, in-app strings, and any other prose we ship or
// commit. This script scans the source globs and fails if it finds one outside
// a small allowlist of intentional, self-documenting exceptions.
//
// En dashes (U+2013) are permitted for numeric ranges only and are not checked
// here.
//
// Run with: npm run lint:em-dash

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOTS = ["server", "client", "shared", "schema", "docs"];
const EXTENSIONS = [".ts", ".tsx", ".md", ".json", ".css", ".html"];

// Lines that legitimately contain the glyph because they document or test the
// rule itself. Keyed by "path:lineNumber" so a moved or duplicated em dash
// elsewhere still fails. Keep this list tiny and justified.
const ALLOWLIST = new Set([
  // The dialog must never render an em dash; this assertion checks its absence.
  "client/src/components/ClearBenchDirtyDialog.test.tsx:88",
  // The brand guide states the rule and shows the forbidden glyph as an example.
  "docs/brand.md:228",
  // The plugin SDK doc states the same rule and shows the glyph as an example.
  "docs/plugin-sdk.md:376",
]);

const NEEDLE = /—|&mdash;/;

function listFiles() {
  // Track only committed/tracked files; mirrors what CI checks out.
  const output = execSync("git ls-files " + ROOTS.join(" "), {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split("\n")
    .filter(Boolean)
    .filter((f) => EXTENSIONS.some((ext) => f.endsWith(ext)))
    .filter((f) => !f.endsWith(".d.ts"));
}

const violations = [];
for (const file of listFiles()) {
  let contents;
  try {
    contents = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!NEEDLE.test(contents)) continue;
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!NEEDLE.test(lines[i])) continue;
    const key = `${file}:${i + 1}`;
    if (ALLOWLIST.has(key)) continue;
    violations.push({ key, text: lines[i].trim() });
  }
}

if (violations.length > 0) {
  console.error(
    `Found ${violations.length} em dash (U+2014 or &mdash;) occurrence(s). CLAUDE.md forbids them.\n` +
      "Replace each with the punctuation that fits the case: period for a sentence break, comma for an aside, " +
      "colon for a label or definition, parentheses for a parenthetical, semicolon for two linked clauses.\n" +
      "En dashes (U+2013) are fine for numeric ranges.\n",
  );
  for (const v of violations) {
    console.error(`  ${v.key}: ${v.text}`);
  }
  process.exit(1);
}

console.log("No disallowed em dashes found.");
