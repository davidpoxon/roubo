// One agent's effective params as a compact summary line.
//
// Extracted from `DefaultAgentTile` (#1063) so the Terminal-tab launch
// menu and the Settings default-agent tile describe the same agent with the
// same string. Two independent formatters would drift, and AP-TC-023 reads the
// menu's summary against what Settings shows.

import type { AgentChoiceProbeState } from "@roubo/shared";
import { enumOptions, type EnumOption } from "../../config-schema-utils";

export const NO_PARAMS_LABEL = "No params configured";

/**
 * Values only, in the order the saved config holds them, so a Claude Code
 * config of `{ model: "opus", effort: "high", posture: "plan" }` reads as
 * "opus · high · plan". Objects and arrays are skipped: this is a summary, not
 * a config viewer, and the full form lives on the AI Agents screen.
 */
export function describeEffectiveParams(config: Record<string, unknown>): string {
  const parts = Object.values(config)
    .filter(
      (value): value is string | number | boolean =>
        typeof value === "string" || typeof value === "number" || typeof value === "boolean",
    )
    .map((value) => String(value))
    .filter((value) => value.length > 0);
  return parts.length > 0 ? parts.join(" · ") : NO_PARAMS_LABEL;
}

/**
 * The three parameter overrides every override surface exposes (AP-TC-025 S002,
 * AP-TC-029 S002). They are per-plugin `configSchema` keys, not core concepts,
 * so each renders as a select when the bound agent declares a closed set of
 * values for it and as a free-text field otherwise.
 *
 * Shared by the agent tool editor (#1057) and the per-launch override dialog
 * (#1072) so the two surfaces offer the same fields in the same order; two
 * private lists would drift.
 */
export const PARAM_FIELDS = [
  { key: "model", label: "Model" },
  { key: "effort", label: "Effort" },
  { key: "mode", label: "Mode" },
] as const;

/**
 * The empty value both override surfaces read as "inherit". It is never written
 * into a params record, which is what makes an untouched field fall through to
 * the layers beneath it (AP-TC-036 S001-O03).
 */
export const INHERIT = "";

/**
 * The values an agent declares for one config key, or `undefined` when the
 * plugin declares no closed set for it (the field is then free text).
 *
 * Delegates to `enumOptions`, the same reader the AI Agents card's config form
 * uses, so both JSON Schema spellings of a choice list are honoured: a bare
 * `enum: [...]`, and the `oneOf: [{ const, title }]` form every shipping agent
 * manifest actually uses. Parsing the schema a second time here is what made
 * these fields fall through to free text while the AI Agents card rendered
 * selects for the very same key (#1104).
 *
 * Only string `const`s survive: both override surfaces hold their draft as
 * strings, and a non-string option could not round-trip through the control.
 * A key whose options are all non-string therefore reads as free text rather
 * than as an empty select.
 *
 * Typed on the structural shape rather than one state interface, because both
 * `AgentPluginState` (Settings) and `ProjectAgentState` (launch surfaces) carry
 * the plugin's `configSchema` under the same name.
 */
export function enumOptionsFor(
  agent: { configSchema?: Record<string, unknown> } | undefined,
  key: string,
): EnumOption[] | undefined {
  const properties = agent?.configSchema?.properties as Record<string, unknown> | undefined;
  const options = enumOptions(properties?.[key]);
  if (options === null) return undefined;
  const strings = options.filter((option) => typeof option.value === "string");
  return strings.length > 0 ? strings : undefined;
}

/**
 * One config key's choice probe while it is still `loading` or has `failed`,
 * or `undefined` when the key has no probe or its probe resolved (#1365).
 *
 * A pending probe-bound field has no choices yet, so `enumOptionsFor` reads it
 * as free text. Every surface that edits the field asks this first and shows
 * the probe's state instead, because free-text entry is what a probed field
 * must not offer (APCC-TC-016).
 *
 * Typed structurally for the same reason as `enumOptionsFor`: both
 * `AgentPluginState` and `ProjectAgentState` carry the same `choiceProbes` map.
 */
export function pendingProbe(
  agent: { choiceProbes?: Record<string, AgentChoiceProbeState> } | undefined,
  key: string,
): AgentChoiceProbeState | undefined {
  const probes = agent?.choiceProbes;
  // `hasOwnProperty` rather than a bare index: the keys come from a plugin's
  // opaque configSchema, so `toString` must not read as a probe.
  if (!probes || !Object.prototype.hasOwnProperty.call(probes, key)) return undefined;
  const probe = probes[key];
  return probe.state === "resolved" ? undefined : probe;
}
