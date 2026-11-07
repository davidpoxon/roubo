import { useId } from "react";
import { ToggleButton, ToggleButtonGroup } from "react-aria-components";
import type { SpecBenchDecisionMode } from "@roubo/shared";
import { DECISION_MODE_OPTIONS } from "./decision-modes";

// DESIGN.md Mode switch: who decides in a delivery (SB-FR-031). Two segments,
// Attended and Auto, in one group; the selected one sits on `accent-muted` in
// `accent-text`, and a note below states what the selected mode does. In the
// set-up dialog it is static, with no pending badge. In the delivery's
// controls (SB-FR-032) `value` is the mode in effect and `pending` the mode a
// switch asked for: the badge shows beside the group while a switch waits for
// the session, and the selected segment moves only when the session applies it.

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
  pending = null,
}: {
  value: SpecBenchDecisionMode;
  onChange: (next: SpecBenchDecisionMode) => void;
  isDisabled?: boolean;
  // The mode a switch asked for while it waits for the session, or null.
  pending?: SpecBenchDecisionMode | null;
}) {
  const labelId = useId();
  const noteId = useId();
  const note = DECISION_MODE_OPTIONS.find((option) => option.id === value)?.note ?? "";

  return (
    <div className="flex flex-col items-start gap-1.5" data-testid="decision-mode-switch">
      <p id={labelId} className="text-13 font-medium text-text-primary">
        Decisions
      </p>
      <div className="flex flex-wrap items-center gap-2">
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
        {pending !== null && (
          <span
            data-testid="decision-mode-pending"
            className="rounded-chip bg-accent-muted px-1.5 py-0.5 text-11 font-medium text-accent-text"
          >
            pending · next boundary
          </span>
        )}
      </div>
      <p id={noteId} data-testid="decision-mode-note" className="text-11 text-text-secondary">
        {note}
      </p>
    </div>
  );
}
