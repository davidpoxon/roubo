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
    <Radio
      value={agent.id}
      className="outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    >
      {({ isSelected, isFocusVisible }) => (
        <div
          data-testid={`default-agent-tile-${agent.id}`}
          // The highlight and the filled check indicator below are both driven
          // by `isSelected`, so mirroring it onto the tile is what lets a
          // browser-driven check observe the VISUAL selection (AP-TC-018
          // S001-O01) rather than only the radio's checked state.
          data-selected={isSelected}
          className={[
            "flex items-center gap-3 px-4 py-3 rounded-lg border text-left transition-colors cursor-pointer select-none",
            isSelected
              ? "border-accent-border bg-accent-muted"
              : "border-border bg-bg-surface hover:border-border-strong hover:bg-bg-hover",
            isFocusVisible ? "ring-2 ring-focus-ring ring-offset-2 ring-offset-bg-base" : "",
          ].join(" ")}
        >
          <div
            className={[
              "w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-colors",
              isSelected ? "border-accent bg-accent" : "border-border-control",
            ].join(" ")}
          />
          <span
            className={`text-13 font-medium ${isSelected ? "text-text-primary" : "text-text-secondary"}`}
          >
            {agent.name}
          </span>
          {/*
            text-secondary clears AA body on the selected tile's accent-muted
            ground as well as on the surface (#703). One colour for both states so
            the subtitle does not shift weight on selection; the hierarchy against
            the agent name reads through size and the monospace face instead.
          */}
          <span className="ml-auto text-11 font-mono text-text-secondary truncate">{params}</span>
        </div>
      )}
    </Radio>
  );
}
