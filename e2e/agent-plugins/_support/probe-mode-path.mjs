// The single definition of the choice-probe mode channel (issue #1306).
//
// Two processes have to agree on this path: the Playwright process (through
// `probe-mode.ts`, which the APCC-TC-022 spec calls to pick a probe state) and
// `e2e/fixtures/bin/roubo-e2e-probe-stub`, which the server spawns as the
// `agent-choice-probe` overlay's choice probe and which reads the mode back.
// Plain ESM for the same reason as `argv-log-path.mjs`: the stub has no
// extension and no build step, so it can load this module but never a
// TypeScript one.
//
// Not an environment variable, for two reasons. The probe spawn strips every
// ROUBO_* variable from the child's environment (`cleanEnv()` in
// server/services/env.ts), and a value read from the environment must not steer
// a filesystem path (CodeQL js/path-injection). The path is built from
// constants only, in the OS temp dir, so nothing lands in the working tree.
import os from "node:os";
import path from "node:path";

/** Where the spec writes, and `roubo-e2e-probe-stub` reads, the probe mode. */
export const PROBE_MODE_PATH = path.join(os.tmpdir(), "roubo-e2e-probe-mode");
