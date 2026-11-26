import type { Bench } from "@roubo/shared";
import { isBenchStale } from "../lib/bench-config.js";
import { isBenchStaleFromSwap } from "./plugin-swap-state.js";
import * as projectRegistry from "./project-registry.js";

/**
 * The bench as a client reads it: the in-memory bench plus `stale`, derived on
 * each read from the snapshot hash and the live project config (HR-FR-004),
 * or from a plugin swap that left one of the bench's resources unbound or the
 * plugin's new process not started (HR-FR-009). `staleFromSwap` is set beside
 * it, only when true, so the client can name the swap as the cause.
 * This is the one place both are set. They are never persisted:
 * toPersistedBench names the fields it writes, and neither is one of them.
 */
export function serializeBench(bench: Bench): Bench {
  const config = projectRegistry.getProject(bench.projectId)?.config;
  const staleFromSwap = isBenchStaleFromSwap(bench.projectId, bench.id);
  return {
    ...bench,
    stale: isBenchStale(bench, config) || staleFromSwap,
    ...(staleFromSwap && { staleFromSwap: true }),
  };
}
