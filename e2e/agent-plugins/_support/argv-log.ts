import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The argv-capture channel shared by `playwright.config.ts` (which exports the
// path to the server as $ROUBO_E2E_AGENT_ARGV_LOG) and the AP-TC-087 spec (which
// reads it back). Declared once here so the two can never drift apart.
//
// The path lives in the OS temp dir rather than in the repo: the Playwright
// process and the server it launches inherit the same TMPDIR, so both resolve the
// same file, and nothing is written into the working tree.

/** Where `e2e/fixtures/bin/roubo-e2e-claude-stub` writes its own argv as JSON. */
export const AGENT_ARGV_LOG_PATH = path.join(os.tmpdir(), "roubo-e2e-agent-argv.json");

/**
 * Remove any argv captured by an earlier launch, so a subsequent read can only
 * observe the launch under test. A missing file is success.
 */
export function clearCapturedArgv(): void {
  fs.rmSync(AGENT_ARGV_LOG_PATH, { force: true });
}

/**
 * The argv the spawned agent CLI actually received, or `null` when nothing has
 * been captured yet (the launch has not reached the child, or was refused before
 * the spawn). An unparseable file also reads as `null`: the writer is atomic
 * enough for a single small write, but a partial read is not evidence of
 * anything and must not be asserted against.
 */
export function readCapturedArgv(): string[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(AGENT_ARGV_LOG_PATH, "utf-8");
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
