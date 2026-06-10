import { RadioGroup, Radio, Label, Button } from "react-aria-components";
import { Check, X, Eraser } from "lucide-react";

// Segmented pass/fail mark control for one observation (#420, FR-007/FR-008).
//
// Built on React Aria's RadioGroup so it is one tab stop with arrow-key
// navigation between the two segments and a visible 2px amber-500 focus ring
// (NFR-004, WCAG 2.1 AA). Colour is never the sole carrier of meaning: each
// segment pairs an icon with a "Pass"/"Fail" text label.
//
// Per DESIGN.md "Observation mark control": unset is stone-500 on a stone-200
// border; pass selected is green-50 / green-800 / green-600 border; fail
// selected is red-50 / red-700 / red-600 border; hover stone-100; disabled
// stone-100 background with stone-300 icons.
//
// The server is the source of truth and records marks set-only (a re-mark of the
// same value re-stamps it). Un-setting a mark is an explicit, separate "Clear"
// affordance, not a click-to-toggle on the segments: it appears only when a mark
// exists and fires onMark(null) to remove the mark entirely (#508). It is its
// own focusable tab stop with the same visible focus ring.

interface ObservationMarkControlProps {
  // The observation this control marks; used to label the group for assistive tech.
  expected: string;
  value: "pass" | "fail" | undefined;
  // Fired with "pass"/"fail" to set a mark, or null to clear it entirely (#508).
  onMark: (result: "pass" | "fail" | null) => void;
  isDisabled?: boolean;
}

const SEGMENT_BASE =
  "flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium cursor-pointer outline-none transition-colors select-none " +
  "first:rounded-l-md last:rounded-r-md border-r border-stone-200 dark:border-stone-700 last:border-r-0 " +
  "text-stone-500 dark:text-stone-400 " +
  "hover:bg-stone-100 dark:hover:bg-stone-800 " +
  "focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-inset focus-visible:relative focus-visible:z-10 " +
  "disabled:cursor-not-allowed disabled:bg-stone-100 dark:disabled:bg-stone-800/40 disabled:text-stone-300 dark:disabled:text-stone-600 disabled:hover:bg-stone-100";

export default function ObservationMarkControl({
  expected,
  value,
  onMark,
  isDisabled,
}: ObservationMarkControlProps) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <RadioGroup
        aria-label={`Mark observation pass or fail: ${expected}`}
        orientation="horizontal"
        value={value ?? null}
        onChange={(next) => onMark(next as "pass" | "fail")}
        isDisabled={isDisabled}
        className="inline-flex"
      >
        <Label className="sr-only">Mark this observation</Label>
        <div className="inline-flex rounded-md border border-stone-200 dark:border-stone-700 overflow-hidden">
          <Radio
            value="pass"
            className={({ isSelected }) =>
              `${SEGMENT_BASE} ${
                isSelected
                  ? "bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-300"
                  : ""
              }`
            }
          >
            <Check aria-hidden="true" className="w-3.5 h-3.5" strokeWidth={2.5} />
            Pass
          </Radio>
          <Radio
            value="fail"
            className={({ isSelected }) =>
              `${SEGMENT_BASE} ${
                isSelected ? "bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300" : ""
              }`
            }
          >
            <X aria-hidden="true" className="w-3.5 h-3.5" strokeWidth={2.5} />
            Fail
          </Radio>
        </div>
      </RadioGroup>
      {value !== undefined && (
        <Button
          aria-label={`Clear mark: ${expected}`}
          onPress={() => onMark(null)}
          isDisabled={isDisabled}
          className="flex items-center justify-center rounded-md p-1 text-stone-400 dark:text-stone-500 outline-none transition-colors cursor-pointer hover:text-stone-700 hover:bg-stone-100 dark:hover:text-stone-200 dark:hover:bg-stone-800 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <Eraser aria-hidden="true" className="w-3.5 h-3.5" strokeWidth={2} />
        </Button>
      )}
    </div>
  );
}
