import type { SpecBenchDecisionMode } from "@roubo/shared";

// The two decision modes of a delivery (SB-FR-031), with the label of each
// Mode switch segment and the note that states what the mode does.
export const DECISION_MODE_OPTIONS: Array<{
  id: SpecBenchDecisionMode;
  label: string;
  note: string;
}> = [
  {
    id: "attended",
    label: "Attended",
    note: "You decide. The session asks, continues on a recorded default, and waits where it must.",
  },
  {
    id: "auto",
    label: "Auto",
    note: "The agent decides. The session records each choice for you to review, and waits only where a human must decide.",
  },
];
