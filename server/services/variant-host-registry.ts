// The VariantHostRegistry (SB-FR-004, SB-NFR-008): the seam through which the
// bench manager asks a bench variant's domain where the bench's components run,
// whether its variant state is still sound, and what must go before the bench's
// own teardown. The bench manager names no variant: a domain registers its host
// here at startup, and a bench whose variant has no host (a normal bench, a
// TestBench) takes the defaults below, which are exactly the behaviour from
// before this seam existed.
import type { Bench, BenchVariant, RegisteredProject } from "@roubo/shared";

/** The outcome of a variant's reconcile check. */
export type VariantStateResult = { ok: true } | { ok: false; error: string };

/**
 * What the bench manager hands a variant host for its pre-teardown work. The
 * host never runs git or touches the terminal service itself: it asks for each
 * removal through these ports, so the bench manager stays the one remover of
 * worktrees and sessions.
 */
export interface VariantTeardownContext {
  project: RegisteredProject | undefined;
  /** Removes a git worktree of the project (not the bench workspace) and its directory. */
  removeWorktree(worktreePath: string): Promise<void>;
  /** Stops one terminal session. A session that is already gone is a no-op. */
  stopSession(sessionId: string): void;
}

/** The three ports a bench variant's domain provides, and the label of its teardown step. */
export interface VariantHost {
  /** The label of the teardown step that runs beforeTeardown, as the bench card shows it. */
  teardownLabel: string;
  /** The directory a component of this bench runs in. */
  componentRoot(bench: Bench): string;
  /** Checks the variant's own state during reconcile. */
  verifyVariantState(bench: Bench): VariantStateResult;
  /** Runs before the bench's terminals, components and workspace are torn down. */
  beforeTeardown(bench: Bench, ctx: VariantTeardownContext): Promise<void>;
  /**
   * Runs right before Cleanup & Retry removes the bench workspace to provision
   * it again, after the bench's sessions and components are stopped. A throw
   * stops the retry with the workspace still there. Optional.
   */
  beforeWorkspaceRemoval?(bench: Bench): void;
}

const hosts = new Map<BenchVariant, VariantHost>();

/** Registers (or replaces) the host of a variant. */
export function registerVariantHost(variant: BenchVariant, host: VariantHost): void {
  hosts.set(variant, host);
}

/** Removes the host of a variant. For tests and for a domain that shuts down. */
export function unregisterVariantHost(variant: BenchVariant): void {
  hosts.delete(variant);
}

/** The host registered for a variant, or undefined for none (or a normal bench). */
export function getVariantHost(variant: BenchVariant | undefined): VariantHost | undefined {
  return variant === undefined ? undefined : hosts.get(variant);
}

/** The component root of a bench: its host's answer, or the bench workspace. */
export function componentRoot(bench: Bench): string {
  return getVariantHost(bench.variant)?.componentRoot(bench) ?? bench.workspacePath;
}

/** The reconcile check of a bench: its host's answer, or sound. */
export function verifyVariantState(bench: Bench): VariantStateResult {
  return getVariantHost(bench.variant)?.verifyVariantState(bench) ?? { ok: true };
}

/** The pre-teardown work of a bench: its host's, or nothing. */
export async function beforeTeardown(bench: Bench, ctx: VariantTeardownContext): Promise<void> {
  await getVariantHost(bench.variant)?.beforeTeardown(bench, ctx);
}

/** The work before Cleanup & Retry removes a bench's workspace: its host's, or nothing. */
export function beforeWorkspaceRemoval(bench: Bench): void {
  getVariantHost(bench.variant)?.beforeWorkspaceRemoval?.(bench);
}

/** The label of a bench's pre-teardown step, or undefined when it has none to show. */
export function teardownLabel(bench: Bench): string | undefined {
  return getVariantHost(bench.variant)?.teardownLabel;
}
