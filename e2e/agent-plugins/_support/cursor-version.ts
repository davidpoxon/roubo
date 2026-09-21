import fs from "node:fs";

import { CURSOR_VERSION_PATH } from "./cursor-version-path.mjs";

// The installed-build channel for the APCC-TC-052 journey.
//
// One shared server serves the whole Playwright run, so the spec cannot swap the
// CLI on the PATH between steps. Instead the `cursor-cli` overlay's probe and
// launch descriptor both name `roubo-e2e-cursor-stub`, and the stub reads this
// file on every `--version` run to decide which build to report. A launch
// refused below the floor drops its cached detection, so the next launch
// spawns the stub again and sees the build the spec has just written.

export { CURSOR_VERSION_PATH };

/**
 * Which build the stub reports on `--version`.
 *
 * - `below`: `2026.09.01-e2e`, older than the overlay's `2026.09.08` floor.
 * - `within`: `2026.09.15-e2e`, on the overlay's inclusive tested ceiling. This is
 *   also what the stub reports when the file is absent, so other specs that
 *   launch Cursor pass the gate without touching this channel.
 */
export type CursorBuild = "below" | "within";

/** The builds the stub prints, keyed by {@link CursorBuild}. */
export const CURSOR_BUILDS: Record<CursorBuild, string> = {
  below: "2026.09.01-e2e",
  within: "2026.09.15-e2e",
};

/** Set the build the next `--version` run reports. */
export function setCursorBuild(build: CursorBuild): void {
  fs.writeFileSync(CURSOR_VERSION_PATH, `${build}\n`, "utf-8");
}

/** Hand the channel back: drop the file, so the stub reads its default. */
export function clearCursorBuild(): void {
  fs.rmSync(CURSOR_VERSION_PATH, { force: true });
}
