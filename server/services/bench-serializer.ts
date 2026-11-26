import type { Bench } from "@roubo/shared";
import { isBenchStale } from "../lib/bench-config.js";
import { isBenchStaleFromSwap } from "./plugin-swap-state.js";
import { isBenchStaleFromRepath } from "./project-repath-state.js";
import * as projectRegistry from "./project-registry.js";

/**
 * The bench as a client reads it: the in-memory bench plus `stale`, derived on
 * each read from the snapshot hash and the live project config (HR-FR-004),
 * from a plugin swap that left one of the bench's resources unbound or the
 * plugin's new process not started (HR-FR-009), or from a re-path of its
 * project since the bench was set up (HR-FR-014). `staleFromSwap` and
 * `staleFromRepath` are set beside it, each only when true, so the client can
 * name the cause. This is the one place all three are set. They are never
 * persisted: toPersistedBench names the fields it writes, and none is one of
 * them.
 */
export function serializeBench(bench: Bench): Bench {
  const config = projectRegistry.getProject(bench.projectId)?.config;
  const staleFromSwap = isBenchStaleFromSwap(bench.projectId, bench.id);
  const staleFromRepath = isBenchStaleFromRepath(bench.projectId, bench.id);
  return {
    ...bench,
    stale: isBenchStale(bench, config) || staleFromSwap || staleFromRepath,
    ...(staleFromSwap && { staleFromSwap: true }),
    ...(staleFromRepath && { staleFromRepath: true }),
  };
}
