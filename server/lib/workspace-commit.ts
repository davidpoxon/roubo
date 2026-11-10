// A commit as a bench workspace knows it: a commit of the workspace itself or,
// in a meta-repo, of one of the mapped submodules the workspace has checked out.
// A delivery's unit commits live in the repository the unit changes, so a
// gate sitting (gate-pin) and a unit's diff (#1659) both look the commit up
// across the workspace and its submodules before they run git on it.
import fs from "node:fs";
import path from "node:path";
import type { RouboConfig } from "@roubo/shared";
import { runCommand } from "../services/exec.js";
import { resolveWithin, UnsafePathError } from "./safe-path.js";

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
const GIT_TIMEOUT_MS = 60_000;

/** The submodule paths a meta-repo project maps, relative to a checkout. */
export function mappedSubmodules(config: RouboConfig | undefined): string[] {
  if (config?.layout.type !== "meta-repo") return [];
  return Object.values(config.layout.submodules ?? {});
}

/** `relative` inside `root`, or undefined when it leaves it. */
export function pathWithin(root: string, relative: string): string | undefined {
  try {
    return resolveWithin(root, relative);
  } catch (err) {
    if (err instanceof UnsafePathError) return undefined;
    throw err;
  }
}

/**
 * The full commit `commit` names in `checkout`, or undefined when git does not
 * know it there. The caller checks `commit` is a hex object name first, so
 * nothing git could read as an option or a revision expression reaches it.
 */
export async function resolveCommitIn(
  checkout: string,
  commit: string,
): Promise<string | undefined> {
  const result = await runCommand(
    "git",
    ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
    checkout,
    GIT_ENV,
    GIT_TIMEOUT_MS,
  );
  const sha = result.stdout.trim();
  return result.code === 0 && sha.length > 0 ? sha : undefined;
}

/**
 * The checkouts of a workspace that can hold a commit, the workspace first and
 * then each mapped submodule it has checked out. A submodule that is not
 * checked out has no `.git` of its own, and git would answer for the
 * superproject there, so it is left out.
 */
export function workspaceCheckouts(
  workspacePath: string,
  config: RouboConfig | undefined,
): { checkout: string; submodulePath?: string }[] {
  const checkouts: { checkout: string; submodulePath?: string }[] = [{ checkout: workspacePath }];
  for (const submodulePath of mappedSubmodules(config)) {
    const checkout = pathWithin(workspacePath, submodulePath);
    if (checkout === undefined || !fs.existsSync(path.join(checkout, ".git"))) continue;
    checkouts.push({ checkout, submodulePath });
  }
  return checkouts;
}

export interface WorkspaceCommit {
  /** The full commit. */
  sha: string;
  /** The checkout that knows it: the workspace, or a mapped submodule in it. */
  checkout: string;
  /** The mapped submodule whose commit it is, relative to the workspace; absent for its own. */
  submodulePath?: string;
}

/**
 * The commit as the workspace knows it, from the first checkout of
 * workspaceCheckouts that knows it. Undefined when none of them does.
 */
export async function resolveWorkspaceCommit(
  workspacePath: string,
  config: RouboConfig | undefined,
  commit: string,
): Promise<WorkspaceCommit | undefined> {
  for (const { checkout, submodulePath } of workspaceCheckouts(workspacePath, config)) {
    const sha = await resolveCommitIn(checkout, commit);
    if (sha !== undefined) {
      return submodulePath === undefined ? { sha, checkout } : { sha, checkout, submodulePath };
    }
  }
  return undefined;
}
