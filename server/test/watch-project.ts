/**
 * The Vitest project of the file-watch test files, and their one budget (#1726).
 *
 * These tests wait on real chokidar events, settle windows and child
 * processes. Each file used to set its own `waitFor` budget and test timeouts,
 * from 4 s up to 30 s, so a test that waited several times could run out of
 * time under a full run. All of them now share the budgets below.
 * `vitest.config.ts` reads this module, so it imports nothing.
 */

/** Every test file that waits on a real watch. The `fs-watch` project runs these. */
export const WATCH_TEST_FILES = [
  "server/services/input-watcher.test.ts",
  "server/services/plugin-dir-watch.test.ts",
  "server/services/project-config-watch.test.ts",
  "server/services/project-lifecycle-watch.test.ts",
  "server/services/state-dir-watch.race.test.ts",
  "server/services/state-dir-watch.test.ts",
];

/**
 * How long one `waitFor` polls before it fails. A passing wait returns as soon
 * as its condition holds, so this budget costs time only when a test fails.
 */
export const WATCH_WAIT_MS = 15_000;

/**
 * The settle window of a watch test that sets its own. Under a full run one
 * write can reach the watch as two events 50 to 110 ms apart, and a shorter
 * window then runs once for each and logs an extra deduped line (#1726).
 */
export const WATCH_SETTLE_MS = 250;

/**
 * How long a watch test waits after its last expected outcome before it
 * asserts that nothing else happened: two settle windows, so a late duplicate
 * event has run and logged before the assertion.
 */
export const WATCH_QUIET_MS = 2 * WATCH_SETTLE_MS;

/**
 * The test and hook timeout of the `fs-watch` project. One test can wait several
 * times, and a wait can use all of `WATCH_WAIT_MS`.
 */
export const WATCH_TEST_TIMEOUT_MS = 60_000;
