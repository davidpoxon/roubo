// The gate pin service of a Spec Bench (SB-FR-024, SB-NFR-006): the sequence
// that opens a gate sitting on a detached worktree at the gate commit, and the
// one that closes it.
//
// Opening a sitting:
//   1. resolves the gate commit, before anything else moves, so a commit git
//      does not know is refused with no worktree created and the components
//      untouched (SB-TC-066). It is looked up in the bench workspace, and in a
//      meta-repo also in each submodule the project maps, because a unit's
//      head there can be a commit of a submodule;
//   2. notes the components that run, and stops the bench components;
//   3. adds a detached worktree beside the workspace, at `<workspacePath>-pin`,
//      under the same workspaces root: at the gate commit, or for a
//      submodule's commit at the workspace's own commit;
//   4. prepares the pin as provisioning prepares a workspace: initialises the
//      submodules of a meta-repo, checks a submodule's gate commit out in that
//      submodule, checks that the pin is at the gate commit, runs
//      `benches.setup` with the pin as its working directory, and marks every
//      component's one-time setup to run again, there;
//   5. records `gatePin`, so the VariantHostRegistry's componentRoot resolves
//      to the pin, and restarts the components that ran, on the bench's own
//      ports, waiting until each launch settles;
//   6. smoke-checks the pinned build: each restarted component runs, each one
//      that reports an http(s) URL answers it with a status below 500, and the
//      pin still checks out the gate commit;
//   7. records `deliverySitting` and persists both, and only then answers.
// When a step from 4 on fails, the pin is undone: the components it started
// stop, the pin worktree goes, the workspace's setup flags come back, and the
// components that ran restart from the workspace before the refusal answers.
//
// Closing a sitting reverses it: stop the components, remove the worktree,
// clear both records, restore the workspace's setup flags, persist, and restart
// the components that ran, from the workspace, waiting until they settle.
//
// The pin is a checkout of its own, so a stack head that moves on in the
// workspace leaves it at its commit (SB-TC-061). Reconcile checks it through
// the Spec Bench host's verifyVariantState after a restart (SB-TC-009).
//
// test-results.json stays in the bench workspace's spec folder during a
// sitting, beside the delivery record, so the marks outlive the sitting's
// close: the sitting names that folder in `resultsSpecPath`.
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Bench,
  BenchDeliverySitting,
  BenchGatePin,
  RegisteredProject,
  RouboConfig,
} from "@roubo/shared";
import { assertSafeWorkspacePath, resolveWithin, UnsafePathError } from "../lib/safe-path.js";
import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as stateService from "./state.js";
import { runCommand } from "./exec.js";

/** A refusal or a failure of the pin sequence, with the HTTP status the route answers. */
export class GatePinError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
    this.name = "GatePinError";
  }
}

// A commit as the record names it: an abbreviated or full hex object name.
// Anything else (an option, a ref expression) never reaches git.
const COMMIT_RE = /^[0-9a-f]{4,64}$/i;

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };
const GIT_TIMEOUT_MS = 60_000;

// The smoke check of a component URL: a few tries, so a server that binds its
// port a moment after it reports running is not refused.
const SMOKE_ATTEMPTS = 3;
const SMOKE_RETRY_MS = 500;
const SMOKE_TIMEOUT_MS = 10_000;

// The benches whose pin sequence runs now, so a second open or close waits for
// none and is refused instead.
const inFlight = new Set<string>();

function benchKey(bench: Bench): string {
  return `${bench.projectId}:${bench.id}`;
}

function git(args: string[], cwd: string) {
  return runCommand("git", args, cwd, GIT_ENV, GIT_TIMEOUT_MS);
}

function notSmokeChecked(detail: string): GatePinError {
  return new GatePinError(
    `The pinned build is not smoke-checked: ${detail}`,
    "BUILD_NOT_SMOKE_CHECKED",
    409,
  );
}

/** The pin path of a bench: a sibling of its workspace, vetted by the safe-path allowlist. */
export function gatePinPath(bench: Pick<Bench, "workspacePath">): string {
  return assertSafeWorkspacePath(`${bench.workspacePath}-pin`, "gate pin path");
}

function persist(bench: Bench): void {
  if (!benchManager.isBenchLive(bench.projectId, bench.id)) return;
  stateService.updateBench(stateService.toPersistedBench(bench));
}

// The components of the bench that run or are starting: those, and only
// those, are restarted once the pin is in place or gone.
function runningComponents(bench: Bench): string[] {
  return Object.entries(bench.components ?? {})
    .filter(([, c]) => c.status === "running" || c.status === "starting")
    .map(([name]) => name);
}

// True when a component of the bench is anything but stopped: those are
// stopped before the component root changes.
function componentsActive(bench: Bench): boolean {
  return Object.values(bench.components ?? {}).some(
    (c) => c.status !== "stopped" && c.status !== "completed",
  );
}

async function stopComponents(bench: Bench): Promise<void> {
  if (!componentsActive(bench)) return;
  await benchManager.stopAllComponents(bench.projectId, bench.id);
}

// Restarts the named components from the bench's current component root and
// waits until each launch settles. A failure is logged, not thrown: the bench
// shows a component that cannot start on its own card.
async function restartComponents(bench: Bench, names: string[]): Promise<void> {
  if (names.length === 0) return;
  try {
    await benchManager.startComponentsAndWait(bench.projectId, bench.id, names);
  } catch (err) {
    console.warn(
      `[gate-pin] Could not restart the components of bench ${bench.id}: ${(err as Error).message}`,
    );
  }
}

// The submodule paths a meta-repo project maps, relative to a checkout.
function mappedSubmodules(config: RouboConfig | undefined): string[] {
  if (config?.layout.type !== "meta-repo") return [];
  return Object.values(config.layout.submodules ?? {});
}

// `relative` inside `root`, or undefined when it leaves it.
function within(root: string, relative: string): string | undefined {
  try {
    return resolveWithin(root, relative);
  } catch (err) {
    if (err instanceof UnsafePathError) return undefined;
    throw err;
  }
}

/** The full commit `commit` names in `checkout`, or undefined when git does not know it there. */
async function resolveIn(checkout: string, commit: string): Promise<string | undefined> {
  const result = await git(["rev-parse", "--verify", "--quiet", `${commit}^{commit}`], checkout);
  const sha = result.stdout.trim();
  return result.code === 0 && sha.length > 0 ? sha : undefined;
}

interface GateCommit {
  /** The full gate commit. */
  sha: string;
  /** The mapped submodule whose commit it is, relative to the checkout; absent for its own. */
  submodulePath?: string;
}

/**
 * The gate commit as the workspace knows it: a commit of the workspace itself,
 * or in a meta-repo a commit of one of the mapped submodules that the
 * workspace has checked out. Undefined when none of them knows it.
 */
async function resolveGateCommit(
  workspacePath: string,
  config: RouboConfig | undefined,
  commit: string,
): Promise<GateCommit | undefined> {
  if (!COMMIT_RE.test(commit)) return undefined;
  const own = await resolveIn(workspacePath, commit);
  if (own !== undefined) return { sha: own };
  for (const submodulePath of mappedSubmodules(config)) {
    const checkout = within(workspacePath, submodulePath);
    // A submodule that is not checked out has no `.git` of its own, and git
    // would answer for the superproject there.
    if (checkout === undefined || !fs.existsSync(path.join(checkout, ".git"))) continue;
    const sha = await resolveIn(checkout, commit);
    if (sha !== undefined) return { sha, submodulePath };
  }
  return undefined;
}

/** The commit a checkout has checked out, or undefined when git cannot read it. */
async function checkedOutCommit(checkout: string): Promise<string | undefined> {
  const result = await git(["rev-parse", "--verify", "HEAD"], checkout);
  const sha = result.stdout.trim();
  return result.code === 0 && sha.length > 0 ? sha : undefined;
}

async function removeWorktree(workspacePath: string, pinPath: string): Promise<string | undefined> {
  const result = await git(["worktree", "remove", "--force", pinPath], workspacePath);
  if (result.code === 0 || !fs.existsSync(pinPath)) return undefined;
  return result.stderr.trim() || `exit code ${result.code}`;
}

/**
 * Checks `sha` out, detached, in a submodule of the pin. The pin's submodule
 * was cloned from its remote, which need not have a unit's commit yet, so a
 * commit it lacks is fetched from the workspace's checkout of the submodule,
 * which knows it. Returns the reason when it cannot.
 */
async function checkOutSubmoduleCommit(
  checkout: string,
  source: string,
  sha: string,
): Promise<string | undefined> {
  if ((await git(["checkout", "-q", "--detach", sha], checkout)).code === 0) return undefined;
  const fetched = await git(["fetch", "-q", source, sha], checkout);
  if (fetched.code !== 0) {
    await git(["fetch", "-q", source, "+refs/heads/*:refs/gate-pin-source/*"], checkout);
  }
  const result = await git(["checkout", "-q", "--detach", sha], checkout);
  return result.code === 0 ? undefined : result.stderr.trim() || `exit code ${result.code}`;
}

// The one-time setup flags of the components, by name.
function setupFlags(bench: Bench): Map<string, boolean> {
  return new Map(
    Object.entries(bench.components ?? {}).map(([name, c]) => [name, c.setupComplete]),
  );
}

// Sets the one-time setup flag of each component that declares a setup:
// complete when `done` names it, else pending, so its next start runs it.
function applySetupFlags(bench: Bench, config: RouboConfig | undefined, done: Set<string>): void {
  for (const [name, status] of Object.entries(bench.components ?? {})) {
    if (!benchManager.componentHasSetup(config?.components[name])) continue;
    status.setupComplete = done.has(name);
  }
}

/** Why `url` fails the smoke check, or undefined when it answers. */
async function probeUrl(url: string): Promise<string | undefined> {
  let last = "no answer";
  for (let attempt = 0; attempt < SMOKE_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(SMOKE_RETRY_MS);
    try {
      const res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(SMOKE_TIMEOUT_MS),
      });
      await res.body?.cancel();
      if (res.status < 500) return undefined;
      last = `answered ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
  }
  return `${url} ${last}`;
}

/**
 * The smoke check of the pinned build: why it fails, or undefined when each
 * restarted component runs (or ran to completion), each one that reports an
 * http(s) URL answers it below 500, and the pin still checks out the commit.
 */
async function smokeCheck(
  bench: Bench,
  names: string[],
  checkout: string,
  sha: string,
): Promise<string | undefined> {
  for (const name of names) {
    const status = bench.components?.[name];
    if (status?.status !== "running" && status?.status !== "completed") {
      const why = status?.error === undefined ? "" : `: ${status.error}`;
      return `component '${name}' is ${status?.status ?? "missing"}${why}`;
    }
  }
  for (const name of names) {
    const url = bench.components?.[name]?.url;
    if (url === undefined || !/^https?:\/\//i.test(url)) continue;
    const failed = await probeUrl(url);
    if (failed !== undefined) return `component '${name}' at ${failed}`;
  }
  const found = await checkedOutCommit(checkout);
  return found === sha ? undefined : `the pin is at ${found ?? "no commit"}, not ${sha}`;
}

async function exclusive<T>(bench: Bench, run: () => Promise<T>): Promise<T> {
  const key = benchKey(bench);
  if (inFlight.has(key)) {
    throw new GatePinError(
      "A gate sitting of this bench is opening or closing: try again once it is done",
      "SITTING_BUSY",
      409,
    );
  }
  inFlight.add(key);
  try {
    return await run();
  } finally {
    inFlight.delete(key);
  }
}

export interface OpenGatePinInput {
  gateId: string;
  /** The gate commit as the delivery record names it. */
  commit: string;
  /** The absolute spec folder in the bench workspace that holds test-results.json. */
  resultsSpecPath: string;
}

/**
 * Opens a gate sitting on a pin at the gate commit, and returns the sitting the
 * bench now has, once the pinned build passed its smoke check. Throws
 * GatePinError: 400 GATE_COMMIT_UNKNOWN when git does not know the commit
 * (nothing moved), 409 SITTING_BUSY while another open or close of the bench
 * runs, 409 GATE_PIN_LEFTOVER when the bench holds a pin with no sitting
 * (nothing moved; the close releases it), 409 GATE_PIN_PATH_TAKEN when a leftover directory holds the pin path,
 * 500 GATE_PIN_FAILED when git cannot add the worktree or the pin is not at the
 * commit, and 409 BUILD_NOT_SMOKE_CHECKED when the pin's setup, the restart of
 * its components or the smoke check fails. After each failure once the
 * components stopped, they restart from the workspace before it throws.
 */
export function openGatePin(bench: Bench, input: OpenGatePinInput): Promise<BenchDeliverySitting> {
  return exclusive(bench, async () => {
    // A pin with no sitting is an open that a server stop cut short after the
    // pin was recorded. Its components may run from it, and its setup flags
    // are the pin's, so a new open would remove it under them and take the
    // pin's flags for the workspace's. The close releases it in order.
    if (bench.gatePin !== undefined) {
      throw new GatePinError(
        `The bench holds a gate pin of gate ${bench.gatePin.gateId} with no sitting: ` +
          "close the sitting to release it, then open it again",
        "GATE_PIN_LEFTOVER",
        409,
      );
    }
    const workspacePath = assertSafeWorkspacePath(bench.workspacePath);
    let pinPath: string;
    try {
      pinPath = gatePinPath(bench);
    } catch (err) {
      if (err instanceof UnsafePathError) {
        throw new GatePinError(err.message, "GATE_PIN_FAILED", 500);
      }
      throw err;
    }
    const project: RegisteredProject | undefined = projectRegistry.getProject(bench.projectId);
    const config = project?.config;

    // 1. The commit, before anything moves.
    const target = await resolveGateCommit(workspacePath, config, input.commit);
    if (target === undefined) {
      throw new GatePinError(
        `The gate commit ${input.commit} of gate ${input.gateId} is unknown to git`,
        "GATE_COMMIT_UNKNOWN",
        400,
      );
    }
    // The commit the pin itself checks out: for a submodule's gate commit, the
    // superproject commit the workspace has, whose submodule then moves.
    const base =
      target.submodulePath === undefined ? target.sha : await checkedOutCommit(workspacePath);
    if (base === undefined) {
      throw new GatePinError(
        `Could not read the commit of the bench workspace ${workspacePath}`,
        "GATE_PIN_FAILED",
        500,
      );
    }
    if (fs.existsSync(pinPath) && (await removeWorktree(workspacePath, pinPath)) !== undefined) {
      throw new GatePinError(
        `The pin path ${pinPath} is taken by a directory git cannot remove`,
        "GATE_PIN_PATH_TAKEN",
        409,
      );
    }

    // 2. The components.
    const running = runningComponents(bench);
    const setupBefore = setupFlags(bench);
    await stopComponents(bench);

    // 3. The detached worktree.
    const added = await git(["worktree", "add", "--detach", pinPath, base], workspacePath);
    if (added.code !== 0) {
      await restartComponents(bench, running);
      throw new GatePinError(
        `Could not pin gate ${input.gateId} at ${target.sha}: ${added.stderr.trim() || `exit code ${added.code}`}`,
        "GATE_PIN_FAILED",
        500,
      );
    }

    // Undoes the pin after a failed step, and hands back the error to throw.
    const abandon = async (err: GatePinError): Promise<GatePinError> => {
      await stopComponents(bench);
      bench.gatePin = undefined;
      for (const [name, done] of setupBefore) {
        const status = bench.components?.[name];
        if (status !== undefined) status.setupComplete = done;
      }
      const leftover = await removeWorktree(workspacePath, pinPath);
      if (leftover !== undefined) {
        console.warn(`[gate-pin] Could not remove the gate pin ${pinPath}: ${leftover}`);
      }
      // A launch from the pin may have written the bench down with its pin.
      persist(bench);
      await restartComponents(bench, running);
      return err;
    };

    // 4. The pin, prepared as a workspace is.
    const submodules = mappedSubmodules(config);
    if (project !== undefined && config !== undefined && submodules.length > 0) {
      const sub = await benchManager.updateWorkspaceSubmodules(
        project.repoPath,
        pinPath,
        submodules,
        config.layout.submoduleInit,
        { benchId: bench.id },
      );
      if (sub?.ok !== true) {
        throw await abandon(
          notSmokeChecked(
            `the submodules of the pin could not be initialised: ${sub?.stderr.trim() || "stopped"}`,
          ),
        );
      }
    }
    let checkout = pinPath;
    if (target.submodulePath !== undefined) {
      const inPin = within(pinPath, target.submodulePath);
      const inWorkspace = within(workspacePath, target.submodulePath);
      const failed =
        inPin === undefined || inWorkspace === undefined
          ? `the submodule path ${target.submodulePath} leaves the checkout`
          : await checkOutSubmoduleCommit(inPin, inWorkspace, target.sha);
      if (failed !== undefined || inPin === undefined) {
        throw await abandon(
          new GatePinError(
            `Could not pin gate ${input.gateId} at ${target.sha} in ${target.submodulePath}: ${failed}`,
            "GATE_PIN_FAILED",
            500,
          ),
        );
      }
      checkout = inPin;
    }
    const pinned = await checkedOutCommit(checkout);
    if (pinned !== target.sha) {
      throw await abandon(
        new GatePinError(
          `Could not pin gate ${input.gateId} at ${target.sha}: the pin is at ${pinned ?? "no commit"}`,
          "GATE_PIN_FAILED",
          500,
        ),
      );
    }
    if (config?.benches.setup) {
      const setup = await benchManager.runBenchSetupCommand(bench, config, pinPath);
      if (setup.code !== 0) {
        throw await abandon(
          notSmokeChecked(
            `benches.setup failed in the pin: ${setup.stderr.trim() || `exit code ${setup.code}`}`,
          ),
        );
      }
    }
    const withSetup = [...setupBefore.keys()].filter((name) =>
      benchManager.componentHasSetup(config?.components[name]),
    );
    const workspaceSetupDone = withSetup.filter((name) => setupBefore.get(name) === true);
    applySetupFlags(bench, config, new Set());

    // 5. The pin record, then the components, from the pin on the bench's own
    // ports.
    const now = new Date().toISOString();
    const pin: BenchGatePin = {
      gateId: input.gateId,
      workspacePath: pinPath,
      commit: target.sha,
      ...(target.submodulePath !== undefined && { submodulePath: target.submodulePath }),
      ...(withSetup.length > 0 && { workspaceSetupDone }),
      createdAt: now,
    };
    bench.gatePin = pin;
    await restartComponents(bench, running);

    // 6. The smoke check of the pinned build.
    const problem = await smokeCheck(bench, running, checkout, target.sha);
    if (problem !== undefined) throw await abandon(notSmokeChecked(problem));

    // 7. The sitting.
    const sitting: BenchDeliverySitting = {
      gateId: input.gateId,
      openedAt: now,
      commit: target.sha,
      state: "open",
      resultsSpecPath: input.resultsSpecPath,
    };
    bench.deliverySitting = sitting;
    persist(bench);
    return sitting;
  });
}

/**
 * Closes the bench's gate sitting: stops the components, removes the pin,
 * clears `gatePin` and `deliverySitting`, restores the workspace's setup flags,
 * persists, and restarts the components that ran, from the workspace, waiting
 * until each launch settles. Throws GatePinError: 404 SITTING_NOT_FOUND when no
 * sitting is open, 409 SITTING_BUSY as the open, and 500 GATE_PIN_FAILED when
 * git cannot remove the pin (the sitting stays, and the components that ran
 * restart from the pin).
 */
export function closeGatePin(bench: Bench): Promise<void> {
  return exclusive(bench, async () => {
    if (bench.deliverySitting === undefined && bench.gatePin === undefined) {
      throw new GatePinError("The bench has no gate sitting open", "SITTING_NOT_FOUND", 404);
    }
    const workspacePath = assertSafeWorkspacePath(bench.workspacePath);
    const running = runningComponents(bench);
    await stopComponents(bench);

    const recorded = bench.gatePin?.workspacePath;
    if (recorded !== undefined) {
      let pinPath: string;
      try {
        pinPath = assertSafeWorkspacePath(recorded, "gate pin path");
      } catch (err) {
        if (!(err instanceof UnsafePathError)) throw err;
        await restartComponents(bench, running);
        throw new GatePinError(err.message, "GATE_PIN_FAILED", 500);
      }
      const leftover = await removeWorktree(workspacePath, pinPath);
      if (leftover !== undefined) {
        await restartComponents(bench, running);
        throw new GatePinError(
          `Could not remove the gate pin ${pinPath}: ${leftover}`,
          "GATE_PIN_FAILED",
          500,
        );
      }
    }

    const done = bench.gatePin?.workspaceSetupDone;
    if (done !== undefined) {
      applySetupFlags(bench, projectRegistry.getProject(bench.projectId)?.config, new Set(done));
    }
    bench.gatePin = undefined;
    bench.deliverySitting = undefined;
    persist(bench);
    await restartComponents(bench, running);
  });
}
