import type { AgentVersionProbeDirective, ChoiceProbeParseMode } from "@roubo/shared";
import type { VersionProbeSpec } from "@roubo/shared/agent-launch-descriptor-schema";
import type { ProbeSpawnOutput } from "./probe-spawn.js";

// The parse-mode registry (#851, APCC-FR-001).
//
// A probe declaration names HOW its output is read with a `parse` literal, and
// this module is the one place a literal turns into a core-owned reader. The
// literals are closed sets owned by the zod schemas (`z.literal("semver")` on the
// version probe, `ChoiceProbeParseModeSchema` on a choice probe), so an unknown
// mode is a validation error at manifest load and never reaches this file. The
// registry is typed as a record over exactly those literals, so adding a literal
// to a schema without adding its reader here fails the typecheck.
//
// Readers name an output SHAPE, never an agent, so this file stays inside what
// `lint:agent-guard` allows.

/** Every parse literal a probe can declare, derived from the schemas that own them. */
export type ProbeParseMode =
  VersionProbeSpec["parse"] | AgentVersionProbeDirective["parse"] | ChoiceProbeParseMode;

/** One choice read from a listing: the value a configuration field stores, and its label. */
export interface ProbeChoice {
  value: string;
  label: string;
}

/** What each parse mode yields on success. */
export interface ProbeValueByMode {
  semver: string;
  "dash-line-pairs": ProbeChoice[];
}

/**
 * The outcome of reading one captured run. `detail` completes a sentence whose
 * subject is the probe's own command line, which the runner prepends.
 */
export type ProbeReading<T> =
  { ok: true; value: T } | { ok: false; cause: "probe-error" | "parse-error"; detail: string };

export type ProbeReader<M extends ProbeParseMode> = (
  output: ProbeSpawnOutput,
) => ProbeReading<ProbeValueByMode[M]>;

/** The most lines a `dash-line-pairs` listing may carry (spike #848). */
export const DASH_LINE_PAIRS_MAX_LINES = 2000;

/** The line rule for `dash-line-pairs` (spike #848). Takes no options. */
const DASH_LINE_PAIR = /^(\S+) - (.+)$/;

/** Parse the first semver anywhere in arbitrary command output. */
export function parseVersion(output: string): string | null {
  const match = output.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/**
 * `semver`: the first `major.minor.patch` anywhere in stdout and stderr merged.
 *
 * Merged, because agents split version output across the two streams
 * inconsistently and the scan is lenient by design. A version found in the output
 * wins even on a nonzero exit, and even in output cut at the size bound: the
 * number is what the probe exists to find, and a CLI that prints it and then
 * complains has still told us.
 */
function readSemver(output: ProbeSpawnOutput): ProbeReading<string> {
  const merged = `${output.stdout}\n${output.stderr}`;
  const version = parseVersion(merged);
  if (version !== null) return { ok: true, value: version };
  if (output.code !== 0) {
    const first = merged.trim().split("\n")[0] ?? "";
    return {
      ok: false,
      cause: "probe-error",
      detail: `exited with code ${output.code}` + (first ? `: ${first}` : ""),
    };
  }
  return { ok: false, cause: "parse-error", detail: "produced no recognisable version number" };
}

/**
 * `dash-line-pairs`: a listing of `<value> - <label>` lines (spike #848).
 *
 * Output cut at the size bound is refused first. Otherwise it reads stdout only,
 * and only after a zero exit. A nonzero exit is a probe error
 * whose reason is the first stderr line: a CLI that failed may still have printed
 * a partial list, and a partial list must not pass for the real one. Every line
 * matching the rule becomes a pair and every other line is skipped, which is what
 * lets a heading, a blank line or a trailing tip sit in the output harmlessly.
 *
 * Values and labels are returned as the plain strings they were printed as.
 * Nothing here interprets markup or control characters, so whatever renders
 * them must treat them as text (APCC-TC-020).
 */
function readDashLinePairs(output: ProbeSpawnOutput): ProbeReading<ProbeChoice[]> {
  // Checked before the exit code: the spawn kills a child at the output bound, so
  // its exit code then says nothing about the CLI.
  if (output.truncated === true) {
    return { ok: false, cause: "parse-error", detail: "printed more output than a listing may" };
  }
  if (output.code !== 0) {
    const first = output.stderr.trim().split(/\r?\n/)[0] ?? "";
    return {
      ok: false,
      cause: "probe-error",
      detail: `exited with code ${output.code}` + (first ? `: ${first}` : ""),
    };
  }
  const lines = output.stdout.split(/\r?\n/);
  if (lines.length > DASH_LINE_PAIRS_MAX_LINES) {
    return {
      ok: false,
      cause: "parse-error",
      detail: `printed more than ${DASH_LINE_PAIRS_MAX_LINES} lines`,
    };
  }
  const pairs: ProbeChoice[] = [];
  for (const line of lines) {
    const match = DASH_LINE_PAIR.exec(line);
    if (match) pairs.push({ value: match[1], label: match[2] });
  }
  if (pairs.length === 0) {
    return { ok: false, cause: "parse-error", detail: "printed no `<value> - <label>` lines" };
  }
  return { ok: true, value: pairs };
}

/** Every parse mode's reader. A record over the closed literal set, so none can be missing. */
export const PROBE_PARSE_REGISTRY: { readonly [M in ProbeParseMode]: ProbeReader<M> } = {
  semver: readSemver,
  "dash-line-pairs": readDashLinePairs,
};

/** Read one captured run with the reader its declaration names. */
export function readProbeOutput<M extends ProbeParseMode>(
  mode: M,
  output: ProbeSpawnOutput,
): ProbeReading<ProbeValueByMode[M]> {
  const reader: ProbeReader<M> = PROBE_PARSE_REGISTRY[mode];
  return reader(output);
}
