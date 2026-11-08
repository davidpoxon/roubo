// The gate pin service of a Spec Bench (SB-FR-023, SB-FR-024, SB-NFR-006): the
// sequence that prepares a gate sitting on a detached worktree at the gate
// commit, the one that opens it, and the one that closes it.
//
// Preparing a sitting (prepareGateSitting) runs when the delivery session posts
// `gate.reached` (see services/delivery-sitting.ts), out of band of the hook's
// answer. It first records `deliverySitting` in state `preparing`, so the gate
// reads waiting for build from the start, then runs steps 1 to 6 below and
// records the smoke check's verdict in `smokeCheck`; a step that cannot pin
// the commit clears the sitting again. The smoke check
// of a prepared pin also fails while no component of the bench runs, since no
// build is then live. While it fails, the pin stays and the check runs again
// every SMOKE_RECHECK_MS, so a build that the operator brings up (a component
// started or restarted, which runs from the pin) passes it. Once it passes, the
// sitting is `ready` and the bench's `delivery-sitting` notification for the
// gate calls the operator. Each change of the sitting goes out as a `controls`
// delivery frame, so the Delivery tab reads it again. The recheck timers live
// in memory: after a server restart, resumeGateSittingWatches starts them again
// for each `preparing` sitting, or starts its preparation again when its pin
// was never recorded.
//
// Opening a sitting on a `ready` pin (openPreparedSitting) moves it to `open`
// and dismisses the notification. A `preparing` one, also while its pin is
// still being made, is refused with 409 BUILD_NOT_SMOKE_CHECKED. With no
// prepared sitting, openGatePin runs the whole
// sequence while the request waits:
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
//   7. records `deliverySitting` in state `open`, with the smoke check's
//      verdict, and persists both, and only then answers.
// When a step from 4 on fails, the pin is undone: the components it started
// stop, the pin worktree goes, the workspace's setup flags come back, and the
// components that ran restart from the workspace before the refusal answers.
// A preparation undoes the pin the same way when a step from 4 to 5 fails, but
// not when the smoke check of step 6 fails: that is the build being down.
//
// Closing a sitting, in any state, reverses it: stop the components, remove
// the worktree, clear both records, restore the workspace's setup flags,
// persist, dismiss the gate's notification, and restart the components that
// ran, from the workspace, waiting until they settle.
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
  BenchSittingSmokeCheck,
  RegisteredProject,
  RouboConfig,
} from "@roubo/shared";
import { assertSafeWorkspacePath, resolveWithin, UnsafePathError } from "../lib/safe-path.js";
import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as stateService from "./state.js";
import { deliveryAcceptedSeq } from "./delivery-event-log.js";
import { runCommand } from "./exec.js";
import { createNotification, dismissByKey } from "./notification.js";
import { broadcastDeliveryFrame } from "./sse.js";

/** The notification that calls the operator to a gate whose build is ready. */
export const DELIVERY_SITTING_NOTIFICATION = "delivery-sitting";

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

// How long a prepared pin whose smoke check failed waits before it checks
// again.
export const SMOKE_RECHECK_MS = 5_000;

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

// A pin in place, its components restarted from it, before its smoke check.
interface PinnedBuild {
  /** The full gate commit. */
  sha: string;
  /** The checkout that holds the gate commit: the pin, or its submodule. */
  checkout: string;
  /** The components that ran before the pin, which restarted from it. */
  running: string[];
  /** When the pin was recorded. */
  now: string;
  /** Undoes the pin, and hands back the error to throw. */
  abandon: (err: GatePinError) => Promise<GatePinError>;
}

/**
 * Steps 1 to 5 of the sequence: the pin at the gate commit, prepared, recorded
 * in `gatePin`, with the components that ran restarted from it. Throws the
 * GatePinErrors that openGatePin names, after it undid what it moved.
 */
async function pinGateCommit(bench: Bench, input: OpenGatePinInput): Promise<PinnedBuild> {
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
  return { sha: target.sha, checkout, running, now, abandon };
}

function smokeVerdict(problem: string | undefined): BenchSittingSmokeCheck {
  const checkedAt = new Date().toISOString();
  return problem === undefined
    ? { passed: true, checkedAt }
    : { passed: false, checkedAt, detail: problem };
}

/**
 * Opens a gate sitting on a pin at the gate commit, and returns the sitting the
 * bench now has, once the pinned build passed its smoke check, which the
 * sitting records in `smokeCheck`. Throws GatePinError: 400
 * GATE_COMMIT_UNKNOWN when git does not know the commit (nothing moved), 409
 * SITTING_BUSY while another open or close of the bench runs, 409
 * GATE_PIN_LEFTOVER when the bench holds a pin with no sitting (nothing moved;
 * the close releases it), 409 GATE_PIN_PATH_TAKEN when a leftover directory
 * holds the pin path, 500 GATE_PIN_FAILED when git cannot add the worktree or
 * the pin is not at the commit, and 409 BUILD_NOT_SMOKE_CHECKED when the pin's
 * setup, the restart of its components or the smoke check fails. After each
 * failure once the components stopped, they restart from the workspace before
 * it throws.
 */
export function openGatePin(bench: Bench, input: OpenGatePinInput): Promise<BenchDeliverySitting> {
  return exclusive(bench, async () => {
    const pinned = await pinGateCommit(bench, input);

    // 6. The smoke check of the pinned build.
    const problem = await smokeCheck(bench, pinned.running, pinned.checkout, pinned.sha);
    if (problem !== undefined) throw await pinned.abandon(notSmokeChecked(problem));

    // 7. The sitting.
    const sitting: BenchDeliverySitting = {
      gateId: input.gateId,
      openedAt: pinned.now,
      commit: pinned.sha,
      state: "open",
      smokeCheck: smokeVerdict(undefined),
      resultsSpecPath: input.resultsSpecPath,
    };
    bench.deliverySitting = sitting;
    persist(bench);
    return sitting;
  });
}

// ── Preparing a sitting on gate.reached (SB-FR-023) ──

// The prepared pins whose smoke check failed and runs again: the gate, the
// components that ran before the pin, and the timer of the next check.
interface SittingWatch {
  gateId: string;
  expected: string[];
  timer?: ReturnType<typeof setTimeout>;
}

const watches = new Map<string, SittingWatch>();

// The preparations that run now, so a caller can wait for one to settle.
const preparations = new Map<string, Promise<BenchDeliverySitting | undefined>>();

function stopWatch(bench: Bench): void {
  const key = benchKey(bench);
  const watch = watches.get(key);
  if (watch?.timer !== undefined) clearTimeout(watch.timer);
  watches.delete(key);
}

// The components whose build the smoke check of a prepared pin reads: those
// that ran before the pin, and each that runs or starts now (one the operator
// started runs from the pin).
function liveBuildNames(bench: Bench, expected: readonly string[]): string[] {
  const names = new Set(expected);
  for (const name of runningComponents(bench)) names.add(name);
  return [...names];
}

// The smoke check of a prepared pin: as the open's, and it also fails while no
// component of a bench that has components runs, since no build is live then.
async function preparedSmokeCheck(
  bench: Bench,
  expected: readonly string[],
  checkout: string,
  sha: string,
): Promise<string | undefined> {
  const names = liveBuildNames(bench, expected);
  if (names.length === 0 && Object.keys(bench.components ?? {}).length > 0) {
    return "no component of the bench runs, so no build is live";
  }
  return smokeCheck(bench, names, checkout, sha);
}

// Tells the Delivery tab that the sitting changed: a `controls` frame, which
// the client never skips, so it reads the snapshot again.
function announce(bench: Bench): void {
  persist(bench);
  broadcastDeliveryFrame(
    bench.projectId,
    bench.id,
    deliveryAcceptedSeq(bench.projectId, bench.id) ?? 0,
    "controls",
  );
}

// Records the verdict of a prepared pin's smoke check: `ready` and the
// operator called when it passed, else the failure and the next check.
function recordPreparedCheck(
  bench: Bench,
  sitting: BenchDeliverySitting,
  problem: string | undefined,
): void {
  const before = sitting.smokeCheck;
  sitting.smokeCheck = smokeVerdict(problem);
  if (problem === undefined) {
    stopWatch(bench);
    sitting.state = "ready";
    announce(bench);
    createNotification(
      bench,
      DELIVERY_SITTING_NOTIFICATION,
      undefined,
      { gateId: sitting.gateId, ...(sitting.commit !== undefined && { commit: sitting.commit }) },
      undefined,
      undefined,
      sitting.gateId,
    );
    return;
  }
  if (before === undefined || before.passed || before.detail !== problem) {
    announce(bench);
  } else {
    persist(bench);
  }
  scheduleRecheck(bench, sitting.gateId);
}

function scheduleRecheck(bench: Bench, gateId: string): void {
  const watch = watches.get(benchKey(bench));
  if (watch === undefined || watch.gateId !== gateId) return;
  if (watch.timer !== undefined) clearTimeout(watch.timer);
  watch.timer = setTimeout(() => {
    watch.timer = undefined;
    void recheckGateSitting(bench).catch((err: unknown) => {
      console.warn(
        `[gate-pin] The smoke check of gate ${gateId} on bench ${bench.id} failed to run: ${(err as Error).message}`,
      );
      scheduleRecheck(bench, gateId);
    });
  }, SMOKE_RECHECK_MS);
  watch.timer.unref?.();
}

/**
 * Prepares the sitting of a gate the delivery reached. It first records
 * `deliverySitting` in state `preparing`, persists it and announces it, so the
 * gate reads waiting for build and POST /sittings is refused with
 * BUILD_NOT_SMOKE_CHECKED from the start. Then it pins the gate commit as
 * openGatePin does (steps 1 to 5), and smoke-checks the pinned build. When the
 * check passes the sitting is `ready` and the `delivery-sitting` notification
 * of the gate calls the operator; while it fails the pin stays and the check
 * runs again every SMOKE_RECHECK_MS. Does nothing, and returns undefined, while
 * the bench has a sitting or a pin already, or another open or close runs. A
 * step that cannot pin the commit undoes what it moved, clears the sitting and
 * returns undefined, logged; the operator can still open the sitting, which
 * then runs the whole sequence. Never throws.
 */
export function prepareGateSitting(
  bench: Bench,
  input: OpenGatePinInput,
): Promise<BenchDeliverySitting | undefined> {
  const key = benchKey(bench);
  const run = (async (): Promise<BenchDeliverySitting | undefined> => {
    if (bench.deliverySitting !== undefined || bench.gatePin !== undefined) return undefined;
    if (inFlight.has(key)) return undefined;
    // Nothing awaits between the checks above and exclusive() below, so no
    // other open or close slips in between.
    const sitting: BenchDeliverySitting = {
      gateId: input.gateId,
      preparedAt: new Date().toISOString(),
      commit: input.commit,
      state: "preparing",
      resultsSpecPath: input.resultsSpecPath,
    };
    bench.deliverySitting = sitting;
    stopWatch(bench);
    try {
      return await exclusive(bench, async () => {
        announce(bench);
        const pinned = await pinGateCommit(bench, input);
        sitting.commit = pinned.sha;
        stopWatch(bench);
        watches.set(key, { gateId: input.gateId, expected: pinned.running });
        const problem = await preparedSmokeCheck(
          bench,
          pinned.running,
          pinned.checkout,
          pinned.sha,
        );
        recordPreparedCheck(bench, sitting, problem);
        return sitting;
      });
    } catch (err) {
      console.warn(
        `[gate-pin] Could not prepare the sitting of gate ${input.gateId} on bench ${bench.id}: ${(err as Error).message}`,
      );
      if (bench.deliverySitting === sitting) {
        if (bench.gatePin === undefined) {
          // No pin was recorded: the gate has nothing to wait on.
          bench.deliverySitting = undefined;
          announce(bench);
        } else {
          // The pin stands, so the gate waits for its build as after a failed
          // smoke check. A step after the pin record can throw before the
          // watch is set, so the watch then reads the components that run now.
          ensureWatch(bench, sitting.gateId);
          scheduleRecheck(bench, sitting.gateId);
        }
      }
      return undefined;
    }
  })();
  preparations.set(key, run);
  void run.finally(() => {
    if (preparations.get(key) === run) preparations.delete(key);
  });
  return run;
}

/** Resolves once the bench's preparation that runs now, if any, settled. */
export async function whenGateSittingPrepared(bench: Bench): Promise<void> {
  await preparations.get(benchKey(bench));
}

// The checkout of the bench's pin that holds the gate commit.
function pinCheckout(pin: BenchGatePin): string | undefined {
  if (pin.submodulePath === undefined) return pin.workspacePath;
  return within(pin.workspacePath, pin.submodulePath);
}

// The watch of the bench's prepared sitting of `gateId`. A sitting prepared
// before a server restart has none in memory: its components are then those
// that run now.
function ensureWatch(bench: Bench, gateId: string): SittingWatch {
  const key = benchKey(bench);
  const watch = watches.get(key);
  if (watch !== undefined && watch.gateId === gateId) return watch;
  stopWatch(bench);
  const fresh: SittingWatch = { gateId, expected: [] };
  watches.set(key, fresh);
  return fresh;
}

/**
 * Runs the smoke check of the bench's `preparing` sitting again, and records
 * its verdict as the preparation does. Returns the sitting, or undefined when
 * the bench has no `preparing` sitting with a pin. While another open or close
 * of the bench runs, skips the check, schedules the next one, and returns the
 * sitting.
 */
export async function recheckGateSitting(bench: Bench): Promise<BenchDeliverySitting | undefined> {
  const stillPreparing = (): boolean =>
    bench.deliverySitting?.state === "preparing" &&
    bench.gatePin !== undefined &&
    bench.gatePin.gateId === bench.deliverySitting.gateId;
  const current = bench.deliverySitting;
  if (!stillPreparing() || current === undefined) {
    stopWatch(bench);
    return undefined;
  }
  const key = benchKey(bench);
  if (inFlight.has(key)) {
    ensureWatch(bench, current.gateId);
    scheduleRecheck(bench, current.gateId);
    return current;
  }
  return exclusive(bench, async () => {
    const sitting = bench.deliverySitting;
    const pin = bench.gatePin;
    if (!stillPreparing() || sitting === undefined || pin === undefined) {
      stopWatch(bench);
      return undefined;
    }
    const watch = ensureWatch(bench, sitting.gateId);
    const checkout = pinCheckout(pin);
    const sha = pin.commit ?? sitting.commit;
    const problem =
      checkout === undefined || sha === undefined
        ? "the pin names no checkout or commit to check"
        : await preparedSmokeCheck(bench, watch.expected, checkout, sha);
    recordPreparedCheck(bench, sitting, problem);
    return sitting;
  });
}

/**
 * Opens the bench's prepared sitting of `gateId` once its smoke check passed:
 * the sitting moves from `ready` to `open`, and the gate's notification goes.
 * Throws GatePinError: 409 BUILD_NOT_SMOKE_CHECKED while the sitting is
 * `preparing`, also while its pin is still being made, 409 SITTING_BUSY as the
 * open, and 404 SITTING_NOT_FOUND when the bench has no prepared sitting of the
 * gate.
 */
export function openPreparedSitting(bench: Bench, gateId: string): Promise<BenchDeliverySitting> {
  const preparing = bench.deliverySitting;
  // A preparation holds the bench while it pins and checks the build, so the
  // refusal comes before exclusive(), which would answer SITTING_BUSY.
  if (preparing?.gateId === gateId && preparing.state === "preparing") {
    const why = preparing.smokeCheck?.detail ?? "the build of the gate is not live yet";
    return Promise.reject(notSmokeChecked(`gate ${gateId} waits for its build: ${why}`));
  }
  return exclusive(bench, async () => {
    const sitting = bench.deliverySitting;
    if (sitting === undefined || sitting.gateId !== gateId) {
      throw new GatePinError(
        `The bench has no prepared sitting of gate ${gateId}`,
        "SITTING_NOT_FOUND",
        404,
      );
    }
    if (sitting.state === "preparing") {
      const why = sitting.smokeCheck?.detail ?? "the build of the gate is not live yet";
      throw notSmokeChecked(`gate ${gateId} waits for its build: ${why}`);
    }
    if (sitting.state === "ready") {
      stopWatch(bench);
      sitting.state = "open";
      sitting.openedAt = new Date().toISOString();
      announce(bench);
      dismissByKey(bench, DELIVERY_SITTING_NOTIFICATION, gateId);
    }
    return sitting;
  });
}

/**
 * Picks up the `preparing` sittings that a server stop left behind, so each
 * gate that waited for its build is called once the build is up. Called once at
 * startup, after reconcile. For a bench whose sitting has its pin, the smoke
 * check runs again after SMOKE_RECHECK_MS, and every SMOKE_RECHECK_MS after
 * that while it fails. A bench whose sitting has no pin yet was stopped while
 * it pinned the gate commit: its preparation starts again from the commit the
 * sitting names. A bench in error, or one that prepares now, is left alone.
 * Never throws.
 */
export function resumeGateSittingWatches(benches: readonly Bench[]): void {
  for (const bench of benches) {
    const sitting = bench.deliverySitting;
    if (sitting?.state !== "preparing" || bench.status === "error") continue;
    const key = benchKey(bench);
    if (preparations.has(key) || inFlight.has(key)) continue;
    const pin = bench.gatePin;
    if (pin !== undefined) {
      if (pin.gateId !== sitting.gateId) continue;
      ensureWatch(bench, sitting.gateId);
      scheduleRecheck(bench, sitting.gateId);
      continue;
    }
    bench.deliverySitting = undefined;
    const commit = sitting.commit;
    const resultsSpecPath = sitting.resultsSpecPath;
    if (commit === undefined || resultsSpecPath === undefined) {
      console.warn(
        `[gate-pin] The sitting of gate ${sitting.gateId} on bench ${bench.id} names no commit to pin: dropped`,
      );
      announce(bench);
      continue;
    }
    void prepareGateSitting(bench, { gateId: sitting.gateId, commit, resultsSpecPath });
  }
}

/** Stops every recheck timer and forgets every preparation; for tests. */
export function forgetGateSittingWatches(): void {
  for (const watch of watches.values()) {
    if (watch.timer !== undefined) clearTimeout(watch.timer);
  }
  watches.clear();
  preparations.clear();
}

/**
 * Closes the bench's gate sitting, in any state: stops the components, removes
 * the pin, clears `gatePin` and `deliverySitting`, restores the workspace's
 * setup flags, persists, dismisses the gate's `delivery-sitting` notification,
 * and restarts the components that ran, from the workspace, waiting until each
 * launch settles. Throws GatePinError: 404 SITTING_NOT_FOUND when the bench has
 * no sitting and no pin, 409 SITTING_BUSY as the open, and 500 GATE_PIN_FAILED when
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
    const gateId = bench.deliverySitting?.gateId ?? bench.gatePin?.gateId;
    stopWatch(bench);
    bench.gatePin = undefined;
    bench.deliverySitting = undefined;
    announce(bench);
    if (gateId !== undefined) dismissByKey(bench, DELIVERY_SITTING_NOTIFICATION, gateId);
    await restartComponents(bench, running);
  });
}
