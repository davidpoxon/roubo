// The gate pin service of a Spec Bench (SB-FR-024, SB-NFR-006): the sequence
// that opens a gate sitting on a detached worktree at the gate commit, and the
// one that closes it.
//
// Opening a sitting:
//   1. resolves the gate commit in the bench workspace, before anything else
//      moves, so a commit git does not know is refused with no worktree created
//      and the components untouched (SB-TC-066);
//   2. stops the bench components;
//   3. adds a detached worktree at the commit beside the workspace, at
//      `<workspacePath>-pin`, under the same workspaces root;
//   4. smoke-checks the pin: its checked-out commit is the gate commit;
//   5. records `gatePin` and `deliverySitting` on the bench and persists them;
//   6. restarts the components that ran, on the bench's own ports. The
//      VariantHostRegistry's componentRoot now resolves to the pin, so they
//      serve the pinned build.
//
// Closing a sitting reverses it: stop the components, remove the worktree,
// clear both records, persist, and restart the components from the workspace.
//
// The pin is a checkout of its own, so a stack head that moves on in the
// workspace leaves it at its commit (SB-TC-061). Reconcile checks it through
// the Spec Bench host's verifyVariantState after a restart (SB-TC-009).
//
// test-results.json stays in the bench workspace's spec folder during a
// sitting, beside the delivery record, so the marks outlive the sitting's
// close: the sitting names that folder in `resultsSpecPath`.
import fs from "node:fs";
import type { Bench, BenchDeliverySitting, BenchGatePin } from "@roubo/shared";
import { assertSafeWorkspacePath, UnsafePathError } from "../lib/safe-path.js";
import * as benchManager from "./bench-manager.js";
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

// The benches whose pin sequence runs now, so a second open or close waits for
// none and is refused instead.
const inFlight = new Set<string>();

function benchKey(bench: Bench): string {
  return `${bench.projectId}:${bench.id}`;
}

function git(args: string[], cwd: string) {
  return runCommand("git", args, cwd, GIT_ENV, GIT_TIMEOUT_MS);
}

/** The pin path of a bench: a sibling of its workspace, vetted by the safe-path allowlist. */
export function gatePinPath(bench: Pick<Bench, "workspacePath">): string {
  return assertSafeWorkspacePath(`${bench.workspacePath}-pin`, "gate pin path");
}

function persist(bench: Bench): void {
  if (!benchManager.isBenchLive(bench.projectId, bench.id)) return;
  stateService.updateBench(stateService.toPersistedBench(bench));
}

// True when a component of the bench runs or is starting: those are restarted
// once the pin is in place or gone.
function componentsRun(bench: Bench): boolean {
  return Object.values(bench.components ?? {}).some(
    (c) => c.status === "running" || c.status === "starting",
  );
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

function restartComponents(bench: Bench, wereRunning: boolean): void {
  if (!wereRunning) return;
  try {
    benchManager.startAllComponents(bench.projectId, bench.id);
  } catch (err) {
    // The bench shows a component that cannot start on its own card; the
    // sitting itself stands.
    console.warn(
      `[gate-pin] Could not restart the components of bench ${bench.id}: ${(err as Error).message}`,
    );
  }
}

/** The full commit `commit` names in the bench workspace, or undefined when git does not know it. */
async function resolveCommit(workspacePath: string, commit: string): Promise<string | undefined> {
  if (!COMMIT_RE.test(commit)) return undefined;
  const result = await git(
    ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
    workspacePath,
  );
  const sha = result.stdout.trim();
  return result.code === 0 && sha.length > 0 ? sha : undefined;
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
 * bench now has. Throws GatePinError: 400 GATE_COMMIT_UNKNOWN when git does not
 * know the commit (nothing moved), 409 SITTING_BUSY while another open or close
 * of the bench runs, 409 GATE_PIN_PATH_TAKEN when a leftover directory holds
 * the pin path, and 500 GATE_PIN_FAILED when git cannot add the worktree or the
 * pin is not at the commit (the components are restarted from the workspace).
 */
export function openGatePin(bench: Bench, input: OpenGatePinInput): Promise<BenchDeliverySitting> {
  return exclusive(bench, async () => {
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

    // 1. The commit, before anything moves.
    const sha = await resolveCommit(workspacePath, input.commit);
    if (sha === undefined) {
      throw new GatePinError(
        `The gate commit ${input.commit} of gate ${input.gateId} is unknown to git`,
        "GATE_COMMIT_UNKNOWN",
        400,
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
    const wereRunning = componentsRun(bench);
    await stopComponents(bench);

    // 3. The detached worktree, and 4. its smoke check.
    const added = await git(["worktree", "add", "--detach", pinPath, sha], workspacePath);
    const pinned = added.code === 0 ? await checkedOutCommit(pinPath) : undefined;
    if (pinned !== sha) {
      const detail =
        added.code !== 0
          ? added.stderr.trim() || `exit code ${added.code}`
          : `the pin is at ${pinned ?? "no commit"}, not ${sha}`;
      if (added.code === 0) await removeWorktree(workspacePath, pinPath);
      restartComponents(bench, wereRunning);
      throw new GatePinError(
        `Could not pin gate ${input.gateId} at ${sha}: ${detail}`,
        "GATE_PIN_FAILED",
        500,
      );
    }

    // 5. The records.
    const now = new Date().toISOString();
    const pin: BenchGatePin = {
      gateId: input.gateId,
      workspacePath: pinPath,
      commit: sha,
      createdAt: now,
    };
    const sitting: BenchDeliverySitting = {
      gateId: input.gateId,
      openedAt: now,
      commit: sha,
      state: "open",
      resultsSpecPath: input.resultsSpecPath,
    };
    bench.gatePin = pin;
    bench.deliverySitting = sitting;
    persist(bench);

    // 6. The components, from the pin on the bench's own ports.
    restartComponents(bench, wereRunning);
    return sitting;
  });
}

/**
 * Closes the bench's gate sitting: stops the components, removes the pin,
 * clears `gatePin` and `deliverySitting`, persists, and restarts the components
 * from the workspace. Throws GatePinError: 404 SITTING_NOT_FOUND when no
 * sitting is open, 409 SITTING_BUSY as the open, and 500 GATE_PIN_FAILED when
 * git cannot remove the pin (the sitting stays, and its components restart
 * from the pin).
 */
export function closeGatePin(bench: Bench): Promise<void> {
  return exclusive(bench, async () => {
    if (bench.deliverySitting === undefined && bench.gatePin === undefined) {
      throw new GatePinError("The bench has no gate sitting open", "SITTING_NOT_FOUND", 404);
    }
    const workspacePath = assertSafeWorkspacePath(bench.workspacePath);
    const wereRunning = componentsRun(bench);
    await stopComponents(bench);

    const recorded = bench.gatePin?.workspacePath;
    if (recorded !== undefined) {
      let pinPath: string;
      try {
        pinPath = assertSafeWorkspacePath(recorded, "gate pin path");
      } catch (err) {
        if (!(err instanceof UnsafePathError)) throw err;
        restartComponents(bench, wereRunning);
        throw new GatePinError(err.message, "GATE_PIN_FAILED", 500);
      }
      const leftover = await removeWorktree(workspacePath, pinPath);
      if (leftover !== undefined) {
        restartComponents(bench, wereRunning);
        throw new GatePinError(
          `Could not remove the gate pin ${pinPath}: ${leftover}`,
          "GATE_PIN_FAILED",
          500,
        );
      }
    }

    bench.gatePin = undefined;
    bench.deliverySitting = undefined;
    persist(bench);
    restartComponents(bench, wereRunning);
  });
}
