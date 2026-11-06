import { useId } from "react";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import type { SpecBenchDecisionMode } from "@roubo/shared";
import { DECISION_MODE_OPTIONS } from "./decision-modes";

// DESIGN.md Mode switch: who decides in a delivery (SB-FR-031). Two segments,
// Attended and Auto, in one group; the selected one sits on `accent-muted` in
// `accent-text`, and a note below states what the selected mode does. This is
// its static use, as in the set-up dialog: no pending badge.

const SEGMENT_CLASS = (selected: boolean) =>
  `px-3 py-1.5 rounded-chip text-13 font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
    selected
      ? "bg-accent-muted text-accent-text"
      : "text-text-body hover:bg-bg-hover data-[pressed]:bg-bg-pressed"
  }`;

export default function ModeSwitch({
  value,
  onChange,
  isDisabled = false,
}: {
  value: SpecBenchDecisionMode;
  onChange: (next: SpecBenchDecisionMode) => void;
  isDisabled?: boolean;
}) {
  const labelId = useId();
  const noteId = useId();
  const note = DECISION_MODE_OPTIONS.find((option) => option.id === value)?.note ?? "";

  return (
    <div className="flex flex-col items-start gap-1.5" data-testid="decision-mode-switch">
      <p id={labelId} className="text-13 font-medium text-text-primary">
        Decisions
      </p>
      <ToggleButtonGroup
        aria-labelledby={labelId}
        aria-describedby={noteId}
        selectionMode="single"
        disallowEmptySelection
        isDisabled={isDisabled}
        selectedKeys={[value]}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          if (next === "attended" || next === "auto") onChange(next);
        }}
        className="flex items-center gap-0.5 p-0.5 bg-bg-surface border border-border-strong rounded-control data-[disabled]:opacity-40"
      >
        {DECISION_MODE_OPTIONS.map((option) => (
          <ToggleButton
            key={option.id}
            id={option.id}
            className={SEGMENT_CLASS(option.id === value)}
          >
            {option.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <p id={noteId} data-testid="decision-mode-note" className="text-11 text-text-secondary">
        {note}
      </p>
    </div>
  );
}
