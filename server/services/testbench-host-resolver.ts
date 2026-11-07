// The TestbenchHostResolver (SB-FR-026, SB-US-009): the one port through which
// the TestBench, gates and focus surfaces ask whether a bench hosts TestBench
// surfaces, and if so where its focused spec lives. The routes name no variant:
// a variant's domain registers a provider here, and a bench whose variant has no
// provider (a normal bench, or any variant that registered none) gets the same
// 400 the per-route `variant === "testbench"` guards returned before this port.
//
// The TestBench variant's provider is registered when this module loads, so the
// existing TestBench behaviour needs no startup wiring.
import type { Bench, BenchVariant } from "@roubo/shared";
import { resolveFocusedSpec } from "../lib/testbench-spec-discovery.js";

/**
 * What a caller wants to do with the bench's TestBench surface:
 *   - read: load the plan, the results or the replacement candidates.
 *   - mark: write a mark, an override, a lifecycle record, a note or a reconcile.
 *   - focus: re-point the bench at another focused spec.
 *   - gate: find the results root a gate reads from.
 */
export type TestbenchHostPurpose = "read" | "mark" | "focus" | "gate";

/** What a provider allows a bench of its variant to do. */
export interface TestbenchHostPermissions {
  /** The bench can be re-pointed at another focused spec. */
  refocusable: boolean;
  /** The bench accepts marks, overrides, notes and reconciles. */
  markable: boolean;
}

/** A resolved TestBench host: the root its spec is read and written under, and its slug. */
export interface TestbenchHost extends TestbenchHostPermissions {
  rootPath: string;
  slug: string;
}

/**
 * The refusal of the port, with the message the route returns: a 400, or a 409
 * when a provider's mark check finds the bench in a state that blocks a mark.
 */
export interface TestbenchHostRefusal {
  ok: false;
  status: 400 | 409;
  error: string;
  /** A BenchError code for the focus purpose, or the code of a mark check's refusal. */
  code?: string;
  /** The blocking classes a 409 CROSSCHECK_BLOCKED names. */
  classes?: string[];
}

export type TestbenchHostResult<T> = { ok: true; host: T } | TestbenchHostRefusal;

/** What a bench variant's domain provides to host TestBench surfaces. */
export interface TestbenchHostProvider extends TestbenchHostPermissions {
  /** The root the focused spec's plan and results are read and written under. */
  rootPath(bench: Bench): string | undefined;
  /**
   * The path of the bench's focused test-cases.json inside the project, which
   * the slug is resolved from.
   */
  focusedSpecPath(bench: Bench): string | undefined;
  /**
   * A check of the bench's own state before a mark, for a variant whose
   * benches accept marks only at some times: the refusal, or undefined when the
   * mark may go on. Only resolveTestbenchMarkHost runs it.
   */
  checkMark?(bench: Bench): Promise<TestbenchHostRefusal | undefined>;
  /**
   * Runs after the case status route wrote a status override, with what it
   * wrote. What it returns is added to the route's answer beside the case
   * result. Never throws: a failure is part of what it returns.
   */
  afterStatusMark?(bench: Bench, mark: TestbenchStatusMark): Promise<Record<string, unknown>>;
}

/** A status override the case status route wrote, as a provider's afterStatusMark reads it. */
export interface TestbenchStatusMark {
  rootPath: string;
  slug: string;
  caseId: string;
  override: string | null;
  /** The note of the mark's evidence, when it carried one. */
  note?: string;
}

/**
 * The TestBench variant (#494): the plan and results live under the bench's own
 * worktree, and the slug comes from the focused spec path, resolved against the
 * project repoPath where it was picked and validated.
 */
export const testbenchHostProvider: TestbenchHostProvider = {
  refocusable: true,
  markable: true,
  rootPath: (bench) => bench.workspacePath,
  focusedSpecPath: (bench) => bench.focusedSpecPath,
};

const providers = new Map<BenchVariant, TestbenchHostProvider>([
  ["testbench", testbenchHostProvider],
]);

/** Registers (or replaces) the TestBench host provider of a variant. */
export function registerTestbenchHostProvider(
  variant: BenchVariant,
  provider: TestbenchHostProvider,
): void {
  providers.set(variant, provider);
}

/** Removes the TestBench host provider of a variant. For tests and for a domain that shuts down. */
export function unregisterTestbenchHostProvider(variant: BenchVariant): void {
  providers.delete(variant);
}

/** The provider registered for a variant, or undefined for none (or a normal bench). */
export function getTestbenchHostProvider(
  variant: BenchVariant | undefined,
): TestbenchHostProvider | undefined {
  return variant === undefined ? undefined : providers.get(variant);
}

const NOT_A_TESTBENCH = "Bench is not a testbench or has no focused spec";

function refuse(error: string, code?: string): TestbenchHostRefusal {
  return code === undefined
    ? { ok: false, status: 400, error }
    : { ok: false, status: 400, error, code };
}

/**
 * Resolves the TestBench host of a bench for one purpose.
 *
 * The focus purpose checks only that the bench's variant can be re-pointed, so
 * it needs no project repoPath and returns the permissions alone: re-pointing
 * validates the new path itself, and a bench with a blank workspace or a
 * malformed current focus can still be re-pointed. A refusal carries the code
 * `NOT_TESTBENCH`.
 *
 * Every other purpose also derives the root and the slug, against `repoPath`,
 * and refuses in this order: no provider (or no focused spec), no usable root,
 * a focused spec path that fails validation.
 */
export function resolveTestbenchHost(
  bench: Bench,
  purpose: "focus",
): TestbenchHostResult<TestbenchHostPermissions>;
export function resolveTestbenchHost(
  bench: Bench,
  purpose: Exclude<TestbenchHostPurpose, "focus">,
  repoPath: string,
): TestbenchHostResult<TestbenchHost>;
export function resolveTestbenchHost(
  bench: Bench,
  purpose: TestbenchHostPurpose,
  repoPath?: string,
): TestbenchHostResult<TestbenchHostPermissions | TestbenchHost> {
  const provider = getTestbenchHostProvider(bench.variant);
  const permissions: TestbenchHostPermissions = {
    refocusable: provider?.refocusable ?? false,
    markable: provider?.markable ?? false,
  };

  if (purpose === "focus") {
    if (!provider) return refuse("Bench is not a testbench variant", "NOT_TESTBENCH");
    if (!provider.refocusable) {
      return refuse("Bench cannot be re-pointed at another spec", "NOT_TESTBENCH");
    }
    return { ok: true, host: permissions };
  }

  const focusedSpecPath = provider?.focusedSpecPath(bench);
  if (!provider || focusedSpecPath === undefined) return refuse(NOT_A_TESTBENCH);
  if (purpose === "mark" && !provider.markable) return refuse("Bench does not accept marks");

  // An error-state bench must not read or write under a bogus root.
  const rootPath = provider.rootPath(bench);
  if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
    return refuse("Bench has no workspace path");
  }

  let slug: string;
  try {
    slug = resolveFocusedSpec(repoPath ?? "", focusedSpecPath).slug;
  } catch (err) {
    return refuse(`Invalid focusedSpecPath: ${(err as Error).message}`);
  }
  return { ok: true, host: { rootPath, slug, ...permissions } };
}

/**
 * Resolves the TestBench host of a bench for a mark, then runs its provider's
 * mark check, if it has one. Every route that writes a mark, an override, a
 * lifecycle record, a note or a reconcile resolves through here.
 */
export async function resolveTestbenchMarkHost(
  bench: Bench,
  repoPath: string,
): Promise<TestbenchHostResult<TestbenchHost>> {
  const resolved = resolveTestbenchHost(bench, "mark", repoPath);
  if (!resolved.ok) return resolved;
  const refusal = await getTestbenchHostProvider(bench.variant)?.checkMark?.(bench);
  return refusal ?? resolved;
}
