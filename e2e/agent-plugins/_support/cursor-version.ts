import fs from "node:fs";

import { CURSOR_BUILDS, CURSOR_VERSION_PATH } from "./cursor-version-path.mjs";

// The installed-build channel for the APCC-TC-052 journey.
//
// One shared server serves the whole Playwright run, so the spec cannot swap the
// CLI on the PATH between steps. Instead the `cursor-cli` overlay's probe and
// launch descriptor both name `roubo-e2e-cursor-stub`, and the stub reads this
// file on every `--version` run to decide which build to report. A launch
// refused below the floor drops its cached detection, so the next launch
// spawns the stub again and sees the build the spec has just written.

export { CURSOR_BUILDS, CURSOR_VERSION_PATH };

/**
 * Which build the stub reports on `--version` (see CURSOR_BUILDS). `within` is
 * also what it reports when the file is absent, so other specs that launch
 * Cursor pass the gate without touching this channel.
 */
export type CursorBuild = keyof typeof CURSOR_BUILDS;

/** Set the build the next `--version` run reports. */
export function setCursorBuild(build: CursorBuild): void {
  fs.writeFileSync(CURSOR_VERSION_PATH, `${build}\n`, "utf-8");
}

/** Hand the channel back: drop the file, so the stub reads its default. */
export function clearCursorBuild(): void {
  fs.rmSync(CURSOR_VERSION_PATH, { force: true });
}
