import { Radio } from "react-aria-components";
import type { AgentPluginState } from "@roubo/shared";

const NO_PARAMS_LABEL = "No params configured";

/**
 * The agent's effective params as one compact line (AP-TC-019 S002).
 *
 * Values only, in the order the saved config holds them, so a Claude Code
 * config of `{ model: "opus", effort: "high", posture: "plan" }` reads as
 * "opus, high, plan". Objects and arrays are skipped: the tile is a summary,
 * not a config viewer, and the full form lives on the AI Agents screen.
 */
function describeEffectiveParams(config: Record<string, unknown>): string {
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
 * One radio tile in the Settings > Jigs default-agent picker (AP-FR-005,
 * issue #515).
 *
 * Structurally the sibling of `JigPickerOption`: the same tile chrome and
 * radio indicator, with the agent's effective params carried as a monospace
 * subtitle so the choice is made against what the agent will actually run.
 */
export default function DefaultAgentTile({ agent }: { agent: AgentPluginState }) {
  const params = describeEffectiveParams(agent.config);

  return (
    <Radio value={agent.id} className="outline-none">
      {({ isSelected, isFocusVisible }) => (
        <div
          className={[
            "flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-all duration-150 cursor-pointer select-none",
            isSelected
              ? "border-stone-400 dark:border-stone-500 bg-stone-100 dark:bg-stone-800/80"
              : "border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900/30 hover:border-stone-300 dark:hover:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800/40",
            isFocusVisible
              ? "ring-2 ring-stone-400 dark:ring-stone-500 ring-offset-2 ring-offset-white dark:ring-offset-stone-950"
              : "",
          ].join(" ")}
        >
          <div
            className={[
              "w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-all duration-150",
              isSelected
                ? "border-stone-700 dark:border-stone-300 bg-stone-700 dark:bg-stone-300"
                : "border-stone-300 dark:border-stone-600",
            ].join(" ")}
          />
          <span
            className={`text-sm font-medium ${isSelected ? "text-stone-900 dark:text-stone-100" : "text-stone-600 dark:text-stone-400"}`}
          >
            {agent.name}
          </span>
          <span className="ml-auto text-[11px] font-mono text-stone-400 dark:text-stone-600 truncate">
            {params}
          </span>
        </div>
      )}
    </Radio>
  );
}
