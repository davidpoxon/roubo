/**
 * Whether an e2e run may use production state (HR-TC-053).
 *
 * The e2e harness never runs against production state: with ROUBO_PRODUCTION
 * set, the state dir is the real `~/.roubo`, and the harness resets and wipes
 * it between specs (issue #877). The packaged-app run of the reload suite is
 * the one exception, since it checks that the app works with its state under
 * `~/.roubo`. It is allowed only when the run asks for it by name and the home
 * directory is a throwaway one under the OS temp dir, so the `~/.roubo` it
 * resets is never a user's: a bench terminal that inherits the app's
 * ROUBO_PRODUCTION does not carry ROUBO_E2E_PACKAGED, and a real home is not
 * under the temp dir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isWithin(child: string, root: string): boolean {
  const rel = path.relative(root, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export interface PackagedE2EStateInput {
  env: NodeJS.ProcessEnv;
  rouboDir: string;
  homeDir?: string;
  tmpDir?: string;
}

/**
 * True when the server runs the packaged e2e run on a throwaway home: ROUBO_E2E,
 * ROUBO_E2E_PACKAGED and ROUBO_PRODUCTION are all set, the state dir is
 * `<home>/.roubo`, and the home directory is inside the OS temp dir.
 */
export function isDisposablePackagedE2EState({
  env,
  rouboDir,
  homeDir = os.homedir(),
  tmpDir = os.tmpdir(),
}: PackagedE2EStateInput): boolean {
  if (env.ROUBO_E2E !== "1" || env.ROUBO_E2E_PACKAGED !== "1" || !env.ROUBO_PRODUCTION) {
    return false;
  }
  const home = realpathOr(homeDir);
  if (!isWithin(home, realpathOr(tmpDir))) return false;
  // The state dir need not exist yet at boot, so its parent is resolved.
  const state = path.join(realpathOr(path.dirname(rouboDir)), path.basename(rouboDir));
  return state === path.join(home, ".roubo");
}
