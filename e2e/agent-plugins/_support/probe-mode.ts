import fs from "node:fs";

import { PROBE_MODE_PATH } from "./probe-mode-path.mjs";

// The choice-probe mode channel for the APCC-TC-022 audit (issue #1306).
//
// One shared server serves the whole Playwright run, so the spec cannot restart
// it between probe states the way the manual #1276 recipe did. Instead the
// `agent-choice-probe` overlay's probe names `roubo-e2e-probe-stub`, and the stub
// reads this file on every run to decide what to print. `/test/__reset` empties
// the host's probe cache, so the next warm spawns the stub again and sees the
// mode the spec has just written.

export { PROBE_MODE_PATH };

/**
 * What the next probe run does.
 *
 * - `resolved`: prints a `<value> - <label>` listing and exits 0 at once.
 * - `slow`: the same listing, after a 3 s sleep (under the host's 4 s kill).
 * - `fail`: prints a reason on stderr and exits non-zero.
 * - `hang`: prints nothing and never exits, until the host kills it.
 */
export type ProbeMode = "resolved" | "slow" | "fail" | "hang";

/** The mode the stub falls back to when the file is absent. */
export const DEFAULT_PROBE_MODE: ProbeMode = "resolved";

/** Set the mode the next probe run reads. */
export function setProbeMode(mode: ProbeMode): void {
  fs.writeFileSync(PROBE_MODE_PATH, `${mode}\n`, "utf-8");
}

/** Hand the channel back: drop the file, so the stub reads its default. */
export function clearProbeMode(): void {
  fs.rmSync(PROBE_MODE_PATH, { force: true });
}
