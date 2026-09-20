#!/usr/bin/env node
// EmittedTokensGuard (issue #1341). `design-tokens/tokens.tailwind.css` is not
// hand-written: the external ui-design `emit_tokens.py` generates it from the
// machine-checkable token block in DESIGN.md, and the result is committed by
// hand. Its own header says so ("managed by emit_tokens.py; edits here are
// overwritten").
//
// Nothing checked that the two still agree. Add a role to DESIGN.md, forget to
// commit the regenerated `@theme` variable, and every gate passes: the
// SemanticDarkGuard only reads `semantic-dark.css`, and the DesignTokenGuard
// reads the legal token names OUT of tokens.tailwind.css, so a name that never
// arrived is simply not a legal token and its absence is never flagged. The
// build compiles, `bg-kind-component-surface` resolves to nothing, and the
// symptom is an unpainted background rather than a failure.
//
// This guard compares both files and fails on a disagreement in either
// direction, including a changed value. It reimplements the slice of
// emit_tokens.py that reaches the Tailwind sink, mirroring ui-design 1.32.2
// (token schema v4): the flatten walk and its order, `normalize_hex`, the
// `alpha` byte, the `px` suffix on a bare numeric length, and the `space.N`
// reference resolution behind `layout.gutter`.
//
// DESIGN.md records more than the emitter writes. These keys are deliberately
// NOT compared, because `flatten_tokens` never walks them:
//
//   elevation_dark  hand-written into design-tokens/semantic-dark.css instead
//   border_width    recorded for humans; no token file carries it
//   opacity         same
//   type.line_height / type.letter_spacing / type.fonts
//                   only type.family, type.scale and type.weights are emitted
//   motion.transitions / motion.keyframes
//                   only motion.primitives.durations and .easings are emitted
//   components / platforms / aesthetic / schema_version
//                   prose and structure, not tokens
//
// Do not "fix" that gap by adding them here. The gate's job is to agree with
// the emitter, so widening it means the emitter widened first.
//
// The check reads two committed text files, so it needs no install and no
// network, and rides in the existing `lint` job.
//
// Run with: npm run lint:emitted-tokens

import { readFileSync } from "node:fs";

export const DESIGN_PATH = "DESIGN.md";
export const TAILWIND_PATH = "design-tokens/tokens.tailwind.css";

// The machine-checkable token block: the first fenced JSON block after the
// `ui-design:tokens` marker comment. Same shape the SemanticDarkGuard reads.
const TOKEN_BLOCK = /<!--\s*ui-design:tokens[^>]*-->\s*```json\s*\n([\s\S]*?)\n```/;

// The managed region sentinels emit_tokens.py writes, of any schema version.
// Everything outside them survives a re-run byte for byte, so the file may
// legally carry hand-written CSS of its own, and only what is between them is
// generated.
const REGION_START =
  /^\/\* ui-design:tokens:start v\d+ - managed by emit_tokens\.py; edits here are overwritten \*\/$/m;
const REGION_END = /^\/\* ui-design:tokens:end \*\/$/m;

// The generated region is a single `@theme { ... }` block. No declaration in
// it nests a brace (`rgb(...)` and `cubic-bezier(...)` are parenthesised), so
// a lazy match to the first column-zero `}` takes the whole block and nothing
// more.
const THEME_BLOCK = /@theme\s*\{([\s\S]*?)\n\}/;

// One `--name: value;` declaration on its own line.
const DECLARATION = /^\s*(--[\w-]+)\s*:\s*([^;]*);\s*$/gm;

// designtokens.HEX_RE: three or six hex digits behind a `#`.
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// emit_tokens._css_value: a bare number (a `length` token) gains a `px` unit.
const BARE_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * The parsed machine-checkable token block of DESIGN.md.
 *
 * @param {string} designMd - DESIGN.md contents.
 * @returns {Record<string, unknown>}
 */
export function designTokens(designMd) {
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
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new Error(`${DESIGN_PATH} token block is not a JSON object.`);
  }
  return tokens;
}

/** A finite, non-boolean number. */
function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * A recorded colour value in the one form the emitter writes, or null when it
 * is not a hex colour at all. Mirrors designtokens.normalize_hex: `#abc`
 * expands to `#AABBCC`, and the result is uppercase.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeHex(value) {
  if (typeof value !== "string" || !HEX.test(value.trim())) return null;
  let digits = value.trim().slice(1);
  if (digits.length === 3) {
    digits = [...digits].map((c) => c + c).join("");
  }
  return `#${digits.toUpperCase()}`;
}

/**
 * A recorded colour `alpha` as the two-digit uppercase hex byte the emitter
 * appends to make an 8 digit `#RRGGBBAA` (`0.4` becomes `66`), or "" when
 * there is no usable alpha. Mirrors emit_tokens._alpha_suffix: absent,
 * non-numeric, boolean, or outside [0, 1] all suppress the suffix, so an
 * alpha-less colour stays a plain `#RRGGBB`.
 *
 * The emitter rounds with Python's `round`, which breaks a tie to the EVEN
 * neighbour, while `Math.round` breaks it upward. Two recordable alphas land
 * exactly on a tie whose floor is even: `0.3` is 76.5 and `0.7` is 178.5, so
 * the emitter writes `4C` and `B2` where `Math.round` would claim `4D` and
 * `B3`. Getting that wrong fails a correctly regenerated file, and re-running
 * the emitter cannot fix it, so the tie is broken the emitter's way here.
 *
 * @param {unknown} alpha
 * @returns {string}
 */
export function alphaSuffix(alpha) {
  if (!isNumber(alpha) || alpha < 0 || alpha > 1) return "";
  const scaled = alpha * 255;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  let byte;
  if (fraction > 0.5) byte = floor + 1;
  else if (fraction < 0.5) byte = floor;
  else byte = floor % 2 === 0 ? floor : floor + 1;
  return byte.toString(16).toUpperCase().padStart(2, "0");
}

/**
 * A token scalar as the emitter stringifies it. An integer-valued float
 * normalizes to an int, so `16.0` renders `16`. Mirrors
 * emit_tokens._stringify.
 */
function stringify(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (isNumber(value) && Number.isInteger(value)) return String(value);
  return String(value);
}

/**
 * A `space.N` reference resolved against the recorded spacing scale, or null
 * on any miss. A value that is already numeric passes through. Mirrors
 * emit_tokens._resolve_length_ref, which exists because `layout.gutter` is a
 * reference key by schema, never a concrete number.
 */
function resolveLengthRef(tokens, value) {
  if (isNumber(value)) return value;
  if (typeof value !== "string") return null;
  const dot = value.indexOf(".");
  if (dot < 0) return null;
  const family = value.slice(0, dot);
  const index = value.slice(dot + 1);
  if ((family !== "space" && family !== "spacing") || !/^\d+$/.test(index)) return null;
  const spacing = tokens.spacing;
  if (!Array.isArray(spacing)) return null;
  const resolved = spacing[Number(index)];
  return isNumber(resolved) ? resolved : null;
}

/**
 * A token value rendered for a CSS sink. A bare numeric length gains a `px`
 * unit; a colour or a raw value passes through. Mirrors
 * emit_tokens._css_value.
 */
function cssValue(value, kind) {
  if (kind === "length" && BARE_NUMBER.test(value)) return `${value}px`;
  return value;
}

/**
 * The token object of DESIGN.md as the ordered `--name: value` declarations
 * emit_tokens.py would write into the `@theme` block.
 *
 * The walk order reproduces emit_tokens.flatten_tokens: colours (key-sorted),
 * then type family / scale / weights, spacing, radius, elevation, motion
 * primitives (each group key-sorted), then the optional layout family.
 * Optional families absent from the token block are skipped, not faulted.
 *
 * @param {Record<string, unknown>} tokens - a parsed DESIGN.md token block.
 * @returns {{name: string, value: string}[]}
 */
export function flattenTokens(tokens) {
  const pairs = [];
  const push = (key, value, kind) =>
    pairs.push({ name: `--${key.replaceAll(".", "-")}`, value: cssValue(value, kind) });

  const colors = tokens.colors || {};
  for (const name of Object.keys(colors).sort()) {
    const record = colors[name] || {};
    const hex = record.hex;
    // A colour with no hex is not emitted at all, so it is not a mismatch.
    if (hex === undefined || hex === null) continue;
    let normalized = normalizeHex(hex);
    // The alpha rides along only on a value the emitter recognised as hex.
    if (normalized !== null) normalized += alphaSuffix(record.alpha);
    push(`color.${name}`, normalized !== null ? normalized : String(hex), "color");
  }

  const type = tokens.type || {};
  if (type.family !== undefined && type.family !== null) {
    push("type.family", String(type.family), "raw");
  }
  (type.scale || []).forEach((size, i) => push(`type.scale.${i}`, stringify(size), "length"));
  (type.weights || []).forEach((w, i) => push(`type.weights.${i}`, stringify(w), "raw"));

  for (const [family, plural] of [
    ["space", "spacing"],
    ["radius", "radius"],
  ]) {
    (tokens[plural] || []).forEach((v, i) => push(`${family}.${i}`, stringify(v), "length"));
  }

  (tokens.elevation || []).forEach((shadow, i) => push(`elevation.${i}`, stringify(shadow), "raw"));

  const primitives = (tokens.motion || {}).primitives || {};
  for (const [group, singular] of [
    ["durations", "duration"],
    ["easings", "easing"],
  ]) {
    const entries = primitives[group] || {};
    for (const name of Object.keys(entries).sort()) {
      push(`motion.${singular}.${name}`, stringify(entries[name]), "raw");
    }
  }

  const layout = tokens.layout || {};
  if ("content_max" in layout) {
    push("layout.content_max", stringify(layout.content_max), "length");
  }
  if ("gutter" in layout) {
    // An unresolvable ref is omitted rather than written through raw, as the
    // emitter omits it: `--layout-gutter: space.6` is not a length.
    const gutter = resolveLengthRef(tokens, layout.gutter);
    if (gutter !== null) push("layout.gutter", stringify(gutter), "length");
  }
  const containers = layout.containers || {};
  for (const name of Object.keys(containers).sort()) {
    push(`layout.containers.${name}`, stringify(containers[name]), "length");
  }

  return pairs;
}

/**
 * Every `--name: value` declaration inside the generated `@theme` block, keyed
 * by name.
 *
 * The block is looked for inside the managed region only. A hand-written
 * `@theme` elsewhere in the file is something the emitter tolerates, since it
 * rewrites nothing outside its sentinels, and reading one instead of the
 * generated block would fault every real token as missing, or hide the
 * generated block entirely.
 *
 * @param {string} css - tokens.tailwind.css contents.
 * @returns {Map<string, string>}
 */
export function themeDeclarations(css) {
  const start = REGION_START.exec(css);
  const end = start ? REGION_END.exec(css.slice(start.index + start[0].length)) : null;
  if (!start || !end) {
    throw new Error(
      `${TAILWIND_PATH} has no \`ui-design:tokens\` managed region. It is generated by ` +
        "the ui-design emit_tokens.py; regenerate it rather than editing it by hand.",
    );
  }
  const region = css.slice(
    start.index + start[0].length,
    start.index + start[0].length + end.index,
  );

  const block = THEME_BLOCK.exec(region);
  if (!block) {
    throw new Error(
      `${TAILWIND_PATH} has no \`@theme { ... }\` block inside its managed region. It is ` +
        "generated by the ui-design emit_tokens.py; regenerate it rather than editing it by hand.",
    );
  }
  const declarations = new Map();
  for (const decl of block[1].matchAll(DECLARATION)) {
    declarations.set(decl[1], decl[2].trim());
  }
  return declarations;
}

/**
 * Where DESIGN.md and the generated `@theme` block disagree.
 *
 * Declaration ORDER is not compared: the emitter is deterministic, but a
 * reordering changes nothing in CSS, so only presence and value are faulted.
 *
 * @param {string} designMd - DESIGN.md contents.
 * @param {string} css - tokens.tailwind.css contents.
 * @returns {{
 *   missing: {name: string, expected: string}[],
 *   extra: {name: string, emitted: string}[],
 *   differing: {name: string, expected: string, emitted: string}[],
 * }} each sorted by token name.
 */
export function tokenMismatches(designMd, css) {
  const expected = flattenTokens(designTokens(designMd));
  const emitted = themeDeclarations(css);

  const missing = [];
  const differing = [];
  const recorded = new Set();
  for (const { name, value } of expected) {
    recorded.add(name);
    if (!emitted.has(name)) {
      missing.push({ name, expected: value });
    } else if (emitted.get(name) !== value) {
      differing.push({ name, expected: value, emitted: emitted.get(name) });
    }
  }

  const extra = [];
  for (const [name, value] of emitted) {
    if (!recorded.has(name)) extra.push({ name, emitted: value });
  }

  const byName = (a, b) => a.name.localeCompare(b.name);
  return {
    missing: missing.sort(byName),
    extra: extra.sort(byName),
    differing: differing.sort(byName),
  };
}

/**
 * The failure report for a set of mismatches: a summary, then one section per
 * direction, each naming every offending token and the line to add, remove or
 * replace. Returns "" when there is nothing to report.
 *
 * Separate from the CLI so the message itself is testable, since naming the
 * offending key and its line is the behaviour the gate is judged on.
 *
 * @param {ReturnType<typeof tokenMismatches>} mismatches
 * @returns {string}
 */
export function formatReport({ missing, extra, differing }) {
  const total = missing.length + extra.length + differing.length;
  if (total === 0) return "";

  const lines = [
    `${DESIGN_PATH} and ${TAILWIND_PATH} disagree on ${total} token(s). ` +
      `${TAILWIND_PATH} is generated: re-run the ui-design emit_tokens.py against ` +
      `${DESIGN_PATH} and commit the result. The exact lines are below.`,
    "",
  ];

  if (missing.length > 0) {
    lines.push(
      `${missing.length} token(s) ${DESIGN_PATH} records that ${TAILWIND_PATH} does not ` +
        "emit. Add inside `@theme`:",
      "",
      ...missing.map(({ name, expected }) => `  ${name}: ${expected};`),
      "",
    );
  }

  if (extra.length > 0) {
    lines.push(
      `${extra.length} token(s) ${TAILWIND_PATH} emits that ${DESIGN_PATH} no longer ` +
        "records. Remove from `@theme`:",
      "",
      ...extra.map(({ name, emitted }) => `  ${name}: ${emitted};`),
      "",
    );
  }

  if (differing.length > 0) {
    lines.push(
      `${differing.length} token(s) whose value differs. Replace the line in \`@theme\`:`,
      "",
      ...differing.map(
        ({ name, expected, emitted }) => `  ${name}: ${expected};   (currently ${emitted})`,
      ),
      "",
    );
  }

  return lines.join("\n");
}

// Only run the CLI when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const designMd = readFileSync(DESIGN_PATH, "utf8");
  const css = readFileSync(TAILWIND_PATH, "utf8");
  const mismatches = tokenMismatches(designMd, css);
  const report = formatReport(mismatches);

  if (report !== "") {
    console.error(report);
    process.exit(1);
  }

  const recorded = flattenTokens(designTokens(designMd)).length;
  console.log(
    `No token drift (${TAILWIND_PATH} emits every one of the ${recorded} tokens ${DESIGN_PATH} records, with no extras).`,
  );
}
