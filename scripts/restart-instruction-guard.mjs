#!/usr/bin/env node
// RestartInstructionGuard (HR-FR-019). Fails when the docs or the client tell
// the user to restart Roubo. Roubo applies a change of roubo.yaml, a plugin
// directory, a setting, a state file or a project registration while it runs,
// so an instruction to restart or relaunch it for one of those is false.
//
// A match is `restart` or `relaunch` (any case, any inflection, with or
// without a hyphen after `re`) followed by `Roubo` or `the app`, also across a
// line break. Every match fails unless a line it spans carries the inline
// allow marker `restart-guard: allow`, followed by the reason the restart is
// still needed: for example a Roubo release update, or a change that Roubo
// refuses to apply live. In Markdown, put the marker in an HTML comment so it
// does not render.
//
// The scan covers the tracked files under docs/ and client/src, and README.md.
// Binary files are skipped.
//
// Run with: npm run lint:restart-instructions

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The paths the guard scans, as git pathspecs. */
export const SCAN_PATHS = ["docs", "client/src", "README.md"];

/** The inline marker that allows a match on the line that carries it. */
export const ALLOW_MARKER = "restart-guard: allow";

const INSTRUCTION = /\bre-?(?:start|launch)(?:s|es|ed|ing)?\s+(?:roubo|the\s+app)\b/gi;

/**
 * Return one finding per match in `contents` that no line of the match allows,
 * as `{ key: "path:line", text }`, where the line is the one the match starts
 * on. Binary contents (a NUL byte) yield none.
 */
export function findRestartInstructions(path, contents) {
  if (contents.includes("\0")) return [];
  const lines = contents.split("\n");
  // The offset at which each line starts, to map a match back to its lines.
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const lineOf = (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const findings = [];
  for (const match of contents.matchAll(INSTRUCTION)) {
    const first = lineOf(match.index);
    const last = lineOf(match.index + match[0].length - 1);
    const allowed = lines.slice(first, last + 1).some((l) => l.includes(ALLOW_MARKER));
    if (allowed) continue;
    findings.push({ key: `${path}:${first + 1}`, text: lines[first].trim() });
  }
  return findings;
}

/** Scan every tracked file under the scan paths of the repository at `cwd`. */
export function scanTrackedFiles(cwd) {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...SCAN_PATHS], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const findings = [];
  for (const file of files) {
    let contents;
    try {
      contents = readFileSync(join(cwd, file), "utf8");
    } catch {
      // A tracked path deleted in the working tree.
      continue;
    }
    findings.push(...findRestartInstructions(file, contents));
  }
  return findings;
}

// Only run the CLI when invoked directly, not when imported by the test.
if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const findings = scanTrackedFiles(process.cwd());

  if (findings.length > 0) {
    console.error(
      `Found ${findings.length} instruction(s) to restart Roubo.\n` +
        "Roubo applies a change of roubo.yaml, a plugin, a setting, a state file or a project registration " +
        "while it runs, so describe what happens live instead. When a restart is still needed, such as for a " +
        `Roubo release update, put the marker "${ALLOW_MARKER}" and the reason on the line.\n`,
    );
    for (const f of findings) console.error(`  ${f.key}: ${f.text}`);
    process.exit(1);
  }

  console.log("No instructions to restart Roubo found.");
}
