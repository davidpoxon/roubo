#!/usr/bin/env node
// SemanticDarkGuard (issue #1297). DESIGN.md records each semantic colour as a
// role: the light value under the canonical key (`text-secondary`) and the dark
// value under a `-dark` sibling (`text-secondary-dark`). The generated
// `design-tokens/tokens.tailwind.css` emits both as flat `--color-*`
// variables, and the hand-written `design-tokens/semantic-dark.css` points the
// base variable at its sibling under `.dark`:
//
//   .dark { --color-text-secondary: var(--color-text-secondary-dark); }
//
// That one line is what lets a single utility (`text-text-secondary`) cover
// both themes with no `dark:` pair at the call site. When DESIGN.md gains a
// `-dark` key and nobody adds the line, nothing fails: the build compiles, the
// light value renders in dark mode, and the only symptom is a contrast defect
// someone has to notice by eye. This guard makes the missing line a CI failure.
//
// The check reads two committed text files, so it needs no install and no
// network, and rides in the existing `lint` job.
//
// Run with: npm run lint:semantic-dark

import { readFileSync } from "node:fs";

export const DESIGN_PATH = "DESIGN.md";
export const SEMANTIC_DARK_PATH = "design-tokens/semantic-dark.css";

// The machine-checkable token block: the first fenced JSON block after the
// `ui-design:tokens` marker comment.
const TOKEN_BLOCK = /<!--\s*ui-design:tokens[^>]*-->\s*```json\s*\n([\s\S]*?)\n```/;

const DARK_SUFFIX = "-dark";

/**
 * The colour roles DESIGN.md records a dark value for, as base names (the
 * `-dark` suffix removed), sorted.
 *
 * @param {string} designMd - DESIGN.md contents.
 * @returns {string[]}
 */
export function darkPairedRoles(designMd) {
  const match = TOKEN_BLOCK.exec(designMd);
  if (!match) {
    throw new Error(
      `${DESIGN_PATH} has no machine-checkable token block (a \`\`\`json fence after ` +
        "the `<!-- ui-design:tokens -->` marker).",
    );
  }
  let tokens;
  try {
    tokens = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`${DESIGN_PATH} token block is not valid JSON: ${err.message}`, { cause: err });
  }
  const colors = tokens?.colors;
  if (!colors || typeof colors !== "object") {
    throw new Error(`${DESIGN_PATH} token block has no \`colors\` object.`);
  }
  return Object.keys(colors)
    .filter((key) => key.endsWith(DARK_SUFFIX) && key.length > DARK_SUFFIX.length)
    .map((key) => key.slice(0, -DARK_SUFFIX.length))
    .sort();
}

/**
 * Every `--color-X: var(--color-X-dark)` redirect declared inside a `.dark`
 * rule, as the set of base names X. A declaration outside `.dark`, or one that
 * points anywhere other than its own sibling, does not count.
 *
 * @param {string} css - semantic-dark.css contents.
 * @returns {Set<string>}
 */
export function declaredRedirects(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const redirects = new Set();
  for (const block of withoutComments.matchAll(/(^|[\s,}])\.dark\s*\{([^}]*)\}/g)) {
    for (const decl of block[2].matchAll(
      /--color-([\w-]+)\s*:\s*var\(\s*--color-([\w-]+)\s*\)\s*;?/g,
    )) {
      if (decl[2] === `${decl[1]}${DARK_SUFFIX}`) redirects.add(decl[1]);
    }
  }
  return redirects;
}

/**
 * The roles DESIGN.md pairs with a dark value that semantic-dark.css never
 * switches to it.
 *
 * @param {string} designMd
 * @param {string} css
 * @returns {string[]} base role names, sorted.
 */
export function missingRedirects(designMd, css) {
  const declared = declaredRedirects(css);
  return darkPairedRoles(designMd).filter((role) => !declared.has(role));
}

// Only run the CLI when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const missing = missingRedirects(
    readFileSync(DESIGN_PATH, "utf8"),
    readFileSync(SEMANTIC_DARK_PATH, "utf8"),
  );

  if (missing.length > 0) {
    console.error(
      `Found ${missing.length} semantic colour(s) with a \`-dark\` value in ${DESIGN_PATH} ` +
        `but no theme switch in ${SEMANTIC_DARK_PATH}. Without the switch, the light ` +
        "value renders in dark mode. Add each line below inside the `.dark` rule:\n",
    );
    for (const role of missing) {
      console.error(`  --color-${role}: var(--color-${role}-dark);`);
    }
    process.exit(1);
  }

  console.log(
    `No missing dark pairs (${SEMANTIC_DARK_PATH} switches every \`-dark\` colour ${DESIGN_PATH} records).`,
  );
}
