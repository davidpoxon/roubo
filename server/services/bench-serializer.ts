import type { Bench } from "@roubo/shared";
import { isBenchStale } from "../lib/bench-config.js";
import * as projectRegistry from "./project-registry.js";

/**
 * The bench as a client reads it: the in-memory bench plus `stale`, derived on
 * each read from the snapshot hash and the live project config (HR-FR-004).
 * This is the one place `stale` is set. It is never persisted:
 * toPersistedBench names the fields it writes, and `stale` is not one of them.
 */
export function serializeBench(bench: Bench): Bench {
  const config = projectRegistry.getProject(bench.projectId)?.config;
  return { ...bench, stale: isBenchStale(bench, config) };
}
