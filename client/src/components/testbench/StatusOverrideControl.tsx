import {
  Select,
  SelectValue,
  Label,
  Button,
  Popover,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
import { ChevronDown } from "lucide-react";
import type { CaseStatus } from "@roubo/shared/testbench-contracts";
import { STATUS_LABEL } from "./StatusIndicator";

// Status override control (#420, FR-010).
//
// Lets the reviewer set any of the five statuses, or fall back to the derived
// value. The currently-overridden status (or the derived status when none is
// set) is the selected value; choosing the derived status clears the override so
// the case reverts to live-derived behaviour. An active override is shown
// distinctly from the derived value via an amber-500 "Override" marker
// (DESIGN.md "Status override control"), and the override takes precedence over
// later marks (server-enforced: displayed status = statusOverride ?? derived).
//
// Built on React Aria's Select so it is one keyboard-operable tab stop with a
// visible amber-500 focus ring (NFR-004, WCAG 2.1 AA).

const STATUS_ORDER: CaseStatus[] = ["not_started", "in_progress", "passed", "failed", "blocked"];

interface StatusOverrideControlProps {
  derivedStatus: CaseStatus;
  // The active override, or undefined when the case is showing its derived value.
  override: CaseStatus | undefined;
  // Fires with the chosen status, or null to clear the override (derived chosen).
  onChange: (override: CaseStatus | null) => void;
  isDisabled?: boolean;
}

export default function StatusOverrideControl({
  derivedStatus,
  override,
  onChange,
  isDisabled,
}: StatusOverrideControlProps) {
  const selected = override ?? derivedStatus;
  return (
    <div className="inline-flex items-center gap-2">
      <Select
        aria-label="Case status"
        selectedKey={selected}
        isDisabled={isDisabled}
        onSelectionChange={(key) => {
          const next = key as CaseStatus;
          // Choosing the derived value clears the override; anything else sets it.
          onChange(next === derivedStatus ? null : next);
        }}
      >
        <Label className="sr-only">Case status</Label>
        <Button className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 px-2.5 py-1 text-xs font-medium text-stone-700 dark:text-stone-200 outline-none transition-colors hover:border-stone-300 dark:hover:border-stone-600 focus-visible:border-amber-500 focus-visible:ring-2 focus-visible:ring-amber-500/40 disabled:cursor-not-allowed disabled:bg-stone-100 dark:disabled:bg-stone-800/40 disabled:text-stone-400 dark:disabled:text-stone-600">
          <SelectValue>{({ selectedText }) => selectedText ?? STATUS_LABEL[selected]}</SelectValue>
          <ChevronDown aria-hidden="true" className="w-3.5 h-3.5 text-stone-400" />
        </Button>
        <Popover className="min-w-[--trigger-width] rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-lg outline-none">
          <ListBox className="p-1 outline-none">
            {STATUS_ORDER.map((status) => (
              <ListBoxItem
                key={status}
                id={status}
                textValue={STATUS_LABEL[status]}
                className="flex items-center justify-between gap-3 rounded px-2 py-1 text-xs text-stone-700 dark:text-stone-200 cursor-pointer outline-none data-[focused]:bg-amber-50 dark:data-[focused]:bg-amber-950/30 data-[focused]:text-amber-900 dark:data-[focused]:text-amber-200"
              >
                <span>{STATUS_LABEL[status]}</span>
                {status === derivedStatus && (
                  <span className="text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-500">
                    derived
                  </span>
                )}
              </ListBoxItem>
            ))}
          </ListBox>
        </Popover>
      </Select>
      {override !== undefined && (
        <span
          data-testid="override-marker"
          className="inline-flex items-center rounded-full border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-300"
        >
          Override
        </span>
      )}
    </div>
  );
}
