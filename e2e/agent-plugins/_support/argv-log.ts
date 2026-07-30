import fs from "node:fs";

import { AGENT_ARGV_LOG_PATH } from "./argv-log-path.mjs";

// The argv-capture channel used by `playwright.config.ts` (which exports the path
// to the server as $ROUBO_E2E_AGENT_ARGV_LOG) and by the AP-TC-087 spec (which
// reads it back).
//
// The path itself comes from `./argv-log-path.mjs` and is re-exported here, so
// the stub agent CLI, which cannot import TypeScript, reads the same definition
// rather than restating it.

export { AGENT_ARGV_LOG_PATH };

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
