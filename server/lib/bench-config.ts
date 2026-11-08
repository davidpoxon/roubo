import { createHash } from "node:crypto";
import type { Bench, ComponentSnapshot, RouboConfig } from "@roubo/shared";
import { canonicalize } from "./canonical-json.js";

// A bench keeps the component definitions it was set up with (HR-FR-003).
//
// The three frozen sections of roubo.yaml are `components`, `ports`, and
// `benches.setup`/`benches.shell`: a running bench reads each of them again on
// every start (a component start, a crash recovery, a boot), so each must come
// from the bench's snapshot rather than the live file. Every other section
// (tools, jigs, integration, users, benches.max, ...) is read live.
//
// `benchConfig` is the one overlay every bench read goes through. A bench with
// no snapshot (a record written before snapshots existed) reads the live config
// unchanged and is never stale (HR-TC-006).

type FrozenDefinitions = Pick<ComponentSnapshot, "components" | "ports" | "benches">;

function frozenDefinitionsOf(config: RouboConfig): FrozenDefinitions {
  return {
    components: config.components ?? {},
    ports: config.ports ?? {},
    benches: { setup: config.benches?.setup, shell: config.benches?.shell },
  };
}

/**
 * The hash of the three frozen sections of a config (HR-FR-004). A change to
 * any other section, such as `tools`, leaves it as it was. The sections go
 * through a JSON round trip first, so an absent key and an `undefined` one hash
 * the same, and then through `canonicalize`, so key order never counts.
 */
export function hashDefinitions(config: RouboConfig): string {
  const plain: unknown = JSON.parse(JSON.stringify(frozenDefinitionsOf(config)));
  return createHash("sha256").update(canonicalize(plain), "utf8").digest("hex");
}

/**
 * A snapshot of the frozen sections of `config`, taken now. It is a deep copy,
 * so a later change to the live config object never reaches it.
 */
export function takeComponentSnapshot(
  config: RouboConfig,
  now: Date = new Date(),
): ComponentSnapshot {
  const definitions = JSON.parse(JSON.stringify(frozenDefinitionsOf(config))) as FrozenDefinitions;
  return {
    components: definitions.components,
    ports: definitions.ports,
    benches: definitions.benches,
    configHash: hashDefinitions(config),
    takenAt: now.toISOString(),
  };
}

/**
 * The config a bench runs under: the live `config` with the bench's snapshot
 * laid over its frozen sections. A bench with no snapshot reads `config`
 * unchanged.
 */
export function benchConfig(
  bench: Pick<Bench, "componentSnapshot"> | undefined,
  config: RouboConfig,
): RouboConfig {
  const snapshot = bench?.componentSnapshot;
  if (!snapshot) return config;
  // `delete` on a copy, so a snapshot without a setup command drops the live
  // one rather than keeping it.
  const benches = { ...config.benches };
  delete benches.setup;
  delete benches.shell;
  if (snapshot.benches.setup !== undefined) benches.setup = snapshot.benches.setup;
  if (snapshot.benches.shell !== undefined) benches.shell = snapshot.benches.shell;
  return {
    ...config,
    components: snapshot.components,
    ports: snapshot.ports,
    benches,
  };
}

/**
 * Whether the bench's snapshot hash differs from the hash of the live config
 * (HR-FR-004). A bench with no snapshot is never stale (HR-TC-006).
 */
export function isBenchStale(
  bench: Pick<Bench, "componentSnapshot">,
  config: RouboConfig | undefined,
): boolean {
  if (!bench.componentSnapshot || !config) return false;
  return bench.componentSnapshot.configHash !== hashDefinitions(config);
}
