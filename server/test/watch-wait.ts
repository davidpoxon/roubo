/**
 * The one `waitFor` of the file-watch test files (#1726). Each file passes the
 * diagnostics it wants in the failure, usually the captured log and events.
 */
import { WATCH_WAIT_MS } from "./watch-project.js";

const POLL_MS = 20;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make the `waitFor` of one test file. The returned function polls `pred`
 * until it holds, and fails after `WATCH_WAIT_MS` with `diagnose()` in the
 * message.
 */
export function createWaitFor(diagnose: () => string): (pred: () => boolean) => Promise<void> {
  return async function waitFor(pred) {
    const end = Date.now() + WATCH_WAIT_MS;
    while (!pred()) {
      if (Date.now() > end) {
        throw new Error(`timed out after ${WATCH_WAIT_MS} ms; ${diagnose()}`);
      }
      await sleep(POLL_MS);
    }
  };
}
