// The single definition of the AP-TC-087 argv-capture channel (issue #531).
//
// Three processes have to agree on this one path: the Playwright process (via
// `playwright.config.ts` and the spec, both of which reach it through
// `argv-log.ts`) and the stub agent CLI at `e2e/fixtures/bin/roubo-e2e-claude-stub`,
// which the server spawns as a PTY child. Plain ESM with an `.mjs` extension
// because that stub has no extension and no build step: it runs straight off
// disk, so it can load this module but could never load a TypeScript one.
//
// The path lives in the OS temp dir rather than in the repo, so nothing is
// written into the working tree.
//
// Built entirely from constants, and it must stay that way: the stub writes to
// this path, so folding in an environment value would turn untrusted input into
// a filesystem destination (CodeQL js/path-injection).
import os from "node:os";
import path from "node:path";

/** Where `e2e/fixtures/bin/roubo-e2e-claude-stub` writes its own argv as JSON. */
export const AGENT_ARGV_LOG_PATH = path.join(os.tmpdir(), "roubo-e2e-agent-argv.json");
