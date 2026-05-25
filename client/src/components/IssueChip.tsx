import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { StatusTone } from "../lib/chip-mapping";

export type IssueChipVariant = "status" | "label" | "issue-type" | "metadata";

interface IssueChipProps {
  variant: IssueChipVariant;
  children: ReactNode;
  icon?: LucideIcon;
  tone?: StatusTone;
  ariaDescription?: string;
}

const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  open: "bg-emerald-500/15 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  "in-progress": "bg-amber-500/15 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  blocked: "bg-red-500/15 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  done: "bg-stone-500/15 text-stone-600 dark:bg-stone-500/20 dark:text-stone-300",
  neutral: "bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-300",
  warning: "bg-amber-500/20 text-amber-800 dark:bg-amber-500/25 dark:text-amber-200",
};

const BASE_CLASSES =
  "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium leading-none";

export default function IssueChip({
  variant,
  children,
  icon: Icon,
  tone = "neutral",
  ariaDescription,
}: IssueChipProps) {
  const variantClasses = classesForVariant(variant, tone);
  const showIcon = Icon !== undefined && variant !== "label";
  const generatedId = useId();
  const describedById = ariaDescription ? `chip-desc-${generatedId}` : undefined;

  return (
    <span
      className={`${BASE_CLASSES} ${variantClasses}`}
      data-chip-category={variant}
      aria-describedby={describedById}
    >
      {showIcon && Icon ? <Icon size={9} aria-hidden="true" /> : null}
      <span className="truncate">{children}</span>
      {ariaDescription ? (
        <span id={describedById} className="sr-only">
          {ariaDescription}
        </span>
      ) : null}
    </span>
  );
}

function classesForVariant(variant: IssueChipVariant, tone: StatusTone): string {
  switch (variant) {
    case "status":
      return `rounded-full ${STATUS_TONE_CLASSES[tone]}`;
    case "label":
      return "rounded-sm border border-cyan-500/40 text-cyan-700 dark:text-cyan-300 bg-transparent";
    case "issue-type":
      return "rounded-full bg-violet-500/15 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300";
    case "metadata":
      return "rounded-full bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-300";
  }
}
