// One agent's effective params as a compact summary line.
//
// Extracted from `DefaultAgentTile` (issue #517) so the Terminal-tab launch
// menu and the Settings default-agent tile describe the same agent with the
// same string. Two independent formatters would drift, and AP-TC-023 reads the
// menu's summary against what Settings shows.

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
