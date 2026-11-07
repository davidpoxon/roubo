// The delivery domain's host for the Spec Bench variant (SB-FR-001, SB-FR-004).
// It answers the three VariantHostRegistry ports for a `specbench` bench:
//
//   - componentRoot: the gate pin worktree while a gate sitting has one, so the
//     operator runs the components against the code under review, else the
//     bench workspace.
//   - verifyVariantState: the focused spec folder, and the pin when one is
//     recorded, must still be on disk, and the pin (or, for a submodule's gate
//     commit, that submodule of the pin) must still check out the commit the
//     bench recorded for it; else the error names the expected and the found
//     commits (SB-TC-009). git runs as a child process that reconcile awaits,
//     so the check never blocks the event loop.
//   - beforeTeardown: Clear bench removes the pin first, then stops the sitting's
//     session, then revokes the delivery token and drops the events and the
//     control outbox held for the bench, and stops its cross-check's watch and
//     timers; the bench manager removes the
//     workspace after that (SB-TC-005).
//
// The session writes the delivery record to `.specifications/<slug>/` inside the
// bench workspace, and the record goes with the workspace when Clear bench or
// Cleanup & Retry removes it; the client warns the operator and asks for a
// confirmation first. Nothing here ever reads, writes or removes the focused
// spec folder in the project checkout for the record: test-results.json in it
// belongs to the checkout and outlives the bench.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { Bench } from "@roubo/shared";
import { assertSafeWorkspacePath, resolveWithin, UnsafePathError } from "./safe-path.js";
import {
  registerVariantHost,
  type VariantHost,
  type VariantStateResult,
  type VariantTeardownContext,
} from "../services/variant-host-registry.js";
import { revokeDeliveryToken } from "../services/delivery-token-registry.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import { forgetDeliveryControls } from "../services/delivery-control-outbox.js";
import { forgetDeliveryCrossCheck } from "../services/delivery-cross-check-loader.js";

/** The pin path of a bench when it passes the safe-path allowlist, else undefined. */
function safePinPath(bench: Bench): string | undefined {
  const pinPath = bench.gatePin?.workspacePath;
  if (pinPath === undefined) return undefined;
  try {
    return assertSafeWorkspacePath(pinPath, "gate pin path");
  } catch (err) {
    if (err instanceof UnsafePathError) return undefined;
    throw err;
  }
}

const execFileAsync = promisify(execFile);

/**
 * The checkout of the pin that holds the recorded commit: the pin itself, or
 * the submodule of it the record names, kept inside the pin. Undefined when
 * the recorded submodule path leaves the pin.
 */
function pinCheckout(pinPath: string, submodulePath: string | undefined): string | undefined {
  if (submodulePath === undefined) return pinPath;
  try {
    return resolveWithin(pinPath, submodulePath);
  } catch (err) {
    if (err instanceof UnsafePathError) return undefined;
    throw err;
  }
}

/** The full commit a checkout has checked out, or undefined when git cannot read one. */
async function checkedOutCommit(checkout: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 5000,
    });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : undefined;
  } catch {
    return undefined;
  }
}

export const specbenchVariantHost: VariantHost = {
  teardownLabel: "Releasing gate pin and session",

  componentRoot(bench: Bench): string {
    return safePinPath(bench) ?? bench.workspacePath;
  },

  async verifyVariantState(bench: Bench): Promise<VariantStateResult> {
    if (!bench.focusedSpecPath || !fs.existsSync(bench.focusedSpecPath)) {
      return {
        ok: false,
        error: `Spec folder not found: ${bench.focusedSpecPath ?? "(none)"}`,
      };
    }
    const pin = bench.gatePin;
    if (pin) {
      const pinPath = safePinPath(bench);
      const expected =
        pin.commit === undefined ? "" : ` (expected commit ${pin.commit}, found none)`;
      if (pinPath === undefined || !fs.existsSync(pinPath)) {
        return {
          ok: false,
          error: `Gate pin worktree not found for gate ${pin.gateId}${expected}: clear this bench to remove it`,
        };
      }
      if (pin.commit !== undefined) {
        const checkout = pinCheckout(pinPath, pin.submodulePath);
        const found = checkout === undefined ? undefined : await checkedOutCommit(checkout);
        if (found !== pin.commit) {
          return {
            ok: false,
            error:
              `Gate pin for gate ${pin.gateId} moved: expected commit ${pin.commit}, ` +
              `found ${found ?? "none"}: clear this bench to remove it`,
          };
        }
      }
    }
    return { ok: true };
  },

  async beforeTeardown(bench: Bench, ctx: VariantTeardownContext): Promise<void> {
    // 1. The pin. Its components ran there, so it goes before anything else.
    const pinPath = safePinPath(bench);
    if (pinPath !== undefined) {
      await ctx.removeWorktree(pinPath);
    }
    bench.gatePin = undefined;
    // 2. The sitting's session. The bench manager removes the workspace next.
    const sessionId = bench.deliverySitting?.sessionId;
    if (sessionId !== undefined) {
      ctx.stopSession(sessionId);
    }
    bench.deliverySitting = undefined;
    // 3. The delivery token (SB-FR-003), the events and the control outbox
    // held for the bench. The bench manager persists the bench right after
    // this step, so the revoked hash and the empty outbox are written down
    // before the workspace goes.
    revokeDeliveryToken(bench);
    forgetDeliveryEventLog(bench.projectId, bench.id);
    forgetDeliveryControls(bench);
    // 4. The cross-check's watch of the workspace and its timers.
    forgetDeliveryCrossCheck(bench.projectId, bench.id);
  },
};

/** Registers the Spec Bench host. Called once at server startup. */
export function registerSpecbenchVariantHost(): void {
  registerVariantHost("specbench", specbenchVariantHost);
}
