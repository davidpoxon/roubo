// The delivery domain's host for the Spec Bench variant (SB-FR-001, SB-FR-004).
// It answers the three VariantHostRegistry ports for a `specbench` bench:
//
//   - componentRoot: the gate pin worktree while a gate sitting has one, so the
//     operator runs the components against the code under review, else the
//     bench workspace.
//   - verifyVariantState: the focused spec folder, and the pin when one is
//     recorded, must still be on disk.
//   - beforeTeardown: Clear bench removes the pin first, then stops the sitting's
//     session, then revokes the delivery token; the bench manager removes the
//     workspace after that (SB-TC-005).
//
// Nothing here ever writes to or removes the focused spec folder in the project
// checkout: test-results.json in it belongs to the checkout and outlives the
// bench. The delivery record is not in that folder: the session writes it to
// `.specifications/<slug>/` inside the bench workspace, which goes with the
// workspace when the bench manager removes it.
import fs from "node:fs";
import type { Bench } from "@roubo/shared";
import { assertSafeWorkspacePath, UnsafePathError } from "./safe-path.js";
import {
  registerVariantHost,
  type VariantHost,
  type VariantStateResult,
  type VariantTeardownContext,
} from "../services/variant-host-registry.js";
import { revokeDeliveryToken } from "../services/delivery-token-registry.js";
import { forgetDeliveryEvents } from "../services/delivery-event-store.js";

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

export const specbenchVariantHost: VariantHost = {
  teardownLabel: "Releasing gate pin and session",

  componentRoot(bench: Bench): string {
    return safePinPath(bench) ?? bench.workspacePath;
  },

  verifyVariantState(bench: Bench): VariantStateResult {
    if (!bench.focusedSpecPath || !fs.existsSync(bench.focusedSpecPath)) {
      return {
        ok: false,
        error: `Spec folder not found: ${bench.focusedSpecPath ?? "(none)"}`,
      };
    }
    if (bench.gatePin) {
      const pinPath = safePinPath(bench);
      if (pinPath === undefined || !fs.existsSync(pinPath)) {
        return {
          ok: false,
          error: `Gate pin worktree not found for gate ${bench.gatePin.gateId}: clear this bench to remove it`,
        };
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
    // 3. The delivery token and the events held for the bench (SB-FR-003). The
    // bench manager persists the bench right after this step, so the revoked
    // hash is written down before the workspace goes.
    revokeDeliveryToken(bench);
    forgetDeliveryEvents(bench.projectId, bench.id);
  },
};

/** Registers the Spec Bench host. Called once at server startup. */
export function registerSpecbenchVariantHost(): void {
  registerVariantHost("specbench", specbenchVariantHost);
}
