import fs from "node:fs";

import { AGENT_ARGV_LOG_PATH, CODEX_ARGV_LOG_PATH } from "./argv-log-path.mjs";

// The argv-capture channels used by `playwright.config.ts` (which switches them
// on for the server as $ROUBO_E2E_AGENT_ARGV_LOG) and by the agent-plugin drift
// guards that read them back: AP-TC-087 reads the Claude Code channel, and the
// AP-TC-056 / AP-TC-105 journeys read the Codex one.
//
// The paths themselves come from `./argv-log-path.mjs` and are re-exported here,
// so the stub agent CLIs, which cannot import TypeScript, read the same
// definitions rather than restating them.

export { AGENT_ARGV_LOG_PATH, CODEX_ARGV_LOG_PATH };

/**
 * Drop one capture file, so a subsequent read can only observe the launch under
 * test. A missing file is success.
 */
function clearLog(logPath: string): void {
  fs.rmSync(logPath, { force: true });
}

/**
 * The argv recorded in one capture file, or `null` when nothing has been
 * captured yet (the launch has not reached the child, or was refused before the
 * spawn). An unparseable file also reads as `null`: the writer is atomic enough
 * for a single small write, but a partial read is not evidence of anything and
 * must not be asserted against.
 */
function readLog(logPath: string): string[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(logPath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return null;
  return parsed;
}

/** Remove any argv captured by an earlier Claude Code launch. */
export function clearCapturedArgv(): void {
  clearLog(AGENT_ARGV_LOG_PATH);
}

/** The argv the spawned Claude Code stub actually received, or `null`. */
export function readCapturedArgv(): string[] | null {
  return readLog(AGENT_ARGV_LOG_PATH);
}

/** Remove any argv captured by an earlier Codex launch. */
export function clearCapturedCodexArgv(): void {
  clearLog(CODEX_ARGV_LOG_PATH);
}

/** The argv the spawned Codex stub actually received, or `null`. */
export function readCapturedCodexArgv(): string[] | null {
  return readLog(CODEX_ARGV_LOG_PATH);
}
