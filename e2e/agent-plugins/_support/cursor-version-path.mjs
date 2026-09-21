// The single definition of the Cursor stub's version channel (APCC-TC-052).
//
// Two processes have to agree on this path: the Playwright process (through
// `cursor-version.ts`, which the APCC-TC-052 spec calls to pick the installed
// build) and `e2e/fixtures/bin/roubo-e2e-cursor-stub`, which the server spawns
// as the `cursor-cli` overlay's version probe and which reads the choice back.
// Plain ESM for the same reason as `probe-mode-path.mjs`: the stub has no
// extension and no build step, so it can load this module but never a
// TypeScript one.
//
// Not an environment variable, for the same two reasons as that module: the
// probe spawn strips every ROUBO_* variable from the child's environment, and a
// value read from the environment must not steer a filesystem path. A separate
// file from PROBE_MODE_PATH, so this channel and the choice-probe one cannot
// leak into each other's specs.
import os from "node:os";
import path from "node:path";

/** Where the spec writes, and `roubo-e2e-cursor-stub` reads, the installed build. */
export const CURSOR_VERSION_PATH = path.join(os.tmpdir(), "roubo-e2e-cursor-version");
