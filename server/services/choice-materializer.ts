import type { AgentChoiceProbeState, ChoiceProbes } from "@roubo/shared";
import type { ProbeResult } from "./agent-probe-runner.js";
import type { ProbeChoice } from "./probe-parse-registry.js";

// Serve probed choices through the existing choice path (#852, APCC-FR-002).
//
// The settings form reads a choice list through one seam (`enumOptions` in the
// client's config-schema-utils): a bare `enum`, or a `oneOf` whose every branch
// is a `{ const, title }`. Rather than teach the form a second, probe-specific
// shape, the host writes a resolved probe's choices into the served schema as
// those same branches, so a probed field and a static choice field are the same
// JSON by the time the form renders them (APCC-TC-003). Each branch keeps the
// choice's id as `const` and its label as `title`, so the form shows the label
// and saves the id (APCC-TC-002).
//
// Pure: the caller supplies the cache-only read, and the manifest's schema is
// never mutated, because it is the shared registry object every reader sees.

/** A cache-only read of one field's last probe outcome. Never spawns. */
export type ChoiceProbeReader = (field: string) => ProbeResult<ProbeChoice[]> | undefined;

export interface MaterializedChoices {
  configSchema?: Record<string, unknown>;
  /** Each probed field's state. Absent when the manifest declares no choice probes. */
  choiceProbes?: Record<string, AgentChoiceProbeState>;
}

function stateOf(outcome: ProbeResult<ProbeChoice[]> | undefined): AgentChoiceProbeState {
  if (outcome === undefined) return { state: "loading" };
  if (outcome.status === "ok") return { state: "resolved" };
  return {
    state: "failed",
    ...(outcome.cause !== undefined && { cause: outcome.cause }),
    ...(outcome.reason !== undefined && { reason: outcome.reason }),
  };
}

/**
 * Merge each resolved choice probe into a copy of `configSchema`, and report
 * every probed field's state beside it.
 *
 * A resolved field's property gets `oneOf: [{ const, title }]`; every other key
 * on the property is kept. A stray static `enum` is dropped defensively (the
 * seam would otherwise read it first), but a probed field should declare none:
 * saves validate against the manifest's own schema, which a static list would
 * narrow below the probed choices. A loading or failed field's property is left as the
 * manifest declared it. A probed field with no matching property is ignored in
 * the schema but still reported in the state map. No probe marker is written
 * into the schema.
 */
export function materializeChoices(
  configSchema: Record<string, unknown> | undefined,
  probes: ChoiceProbes | undefined,
  read: ChoiceProbeReader,
): MaterializedChoices {
  if (probes === undefined || Object.keys(probes).length === 0) return { configSchema };

  const choiceProbes: Record<string, AgentChoiceProbeState> = {};
  const schema: Record<string, unknown> | undefined =
    configSchema === undefined ? undefined : structuredClone(configSchema);
  const properties = schema?.properties;
  const props =
    properties !== null && typeof properties === "object" && !Array.isArray(properties)
      ? (properties as Record<string, unknown>)
      : undefined;

  for (const field of Object.keys(probes)) {
    const outcome = read(field);
    choiceProbes[field] = stateOf(outcome);
    if (outcome?.status !== "ok" || outcome.value === undefined) continue;

    // Own properties only, so a field named like an Object.prototype member never
    // reads (or writes) through the prototype chain.
    if (props === undefined || !Object.hasOwn(props, field)) continue;
    const prop = props[field];
    if (prop === null || typeof prop !== "object" || Array.isArray(prop)) {
      continue;
    }
    const next: Record<string, unknown> = { ...(prop as Record<string, unknown>) };
    delete next.enum;
    next.oneOf = outcome.value.map((choice) => ({ const: choice.value, title: choice.label }));
    props[field] = next;
  }

  return { configSchema: schema, choiceProbes };
}
