import { Radio } from "react-aria-components";
import type { AgentPluginState } from "@roubo/shared";
// Shared with the Terminal-tab launch menu (AP-TC-019 S002, AP-TC-023) so the
// same agent reads identically in both places.
import { describeEffectiveParams } from "./agent-params";

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
          data-testid={`default-agent-tile-${agent.id}`}
          // The highlight and the filled check indicator below are both driven
          // by `isSelected`, so mirroring it onto the tile is what lets a
          // browser-driven check observe the VISUAL selection (AP-TC-018
          // S001-O01) rather than only the radio's checked state.
          data-selected={isSelected}
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
          {/*
            stone-600, not the muted stone-500 used elsewhere: the selected tile's
            background is stone-100, where stone-500 measures 4.38:1 and misses AA
            body (#703). One colour for both states so the subtitle does not shift
            weight on selection; the hierarchy against the agent name reads through
            size and the monospace face instead.
          */}
          <span className="ml-auto text-[11px] font-mono text-stone-600 dark:text-stone-400 truncate">
            {params}
          </span>
        </div>
      )}
    </Radio>
  );
}
