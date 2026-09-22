// The single definition of the argv-capture channels (#1083, #1128), and
// of the Cursor stub's working-directory channel beside them.
//
// Three processes have to agree on these paths: the Playwright process (via
// `playwright.config.ts` and the specs, both of which reach them through
// `argv-log.ts`) and the stub agent CLIs under `e2e/fixtures/bin/`, which the
// server spawns as PTY children. Plain ESM with an `.mjs` extension because
// those stubs have no extension and no build step: they run straight off disk,
// so they can load this module but could never load a TypeScript one.
//
// ONE PATH PER STUB, deliberately. Each log is a single file, last write wins,
// and two guards can have live sessions at once (the AP-TC-056 / AP-TC-105
// journeys enable the codex overlay while the ambient claude overlay is still
// installed). Sharing one destination would let either child clobber the other's
// evidence, so each stub writes its own.
//
// The paths live in the OS temp dir rather than in the repo, so nothing is
// written into the working tree.
//
// Built entirely from constants, and they must stay that way: the stubs write to
// these paths, so folding in an environment value would turn untrusted input into
// a filesystem destination (CodeQL js/path-injection).
import os from "node:os";
import path from "node:path";

/** Where `e2e/fixtures/bin/roubo-e2e-claude-stub` writes its own argv as JSON. */
export const AGENT_ARGV_LOG_PATH = path.join(os.tmpdir(), "roubo-e2e-agent-argv.json");

/** Where `e2e/fixtures/bin/roubo-e2e-codex-stub` writes its own argv as JSON. */
export const CODEX_ARGV_LOG_PATH = path.join(os.tmpdir(), "roubo-e2e-codex-argv.json");

/** Where `e2e/fixtures/bin/roubo-e2e-cursor-stub` writes its own argv as JSON. */
export const CURSOR_ARGV_LOG_PATH = path.join(os.tmpdir(), "roubo-e2e-cursor-argv.json");

/**
 * Where `e2e/fixtures/bin/roubo-e2e-cursor-stub` writes its own working
 * directory, as plain text. No API surface reports where a session runs, so the
 * APCC-TC-031 journey reads the child's own `process.cwd()` from here.
 */
export const CURSOR_CWD_LOG_PATH = path.join(os.tmpdir(), "roubo-e2e-cursor-cwd.txt");
