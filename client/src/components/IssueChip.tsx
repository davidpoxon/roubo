import { useId, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button, TooltipTrigger } from "react-aria-components";
import type { SecurityCategory, StatusTone } from "../lib/chip-mapping";
import Tooltip from "./ui/Tooltip";
import { focusRing } from "./ui/focus-ring";

export type IssueChipVariant =
  "status" | "milestone" | "label" | "issue-type" | "metadata" | "security-category";

interface IssueChipProps {
  variant: IssueChipVariant;
  children: ReactNode;
  icon?: LucideIcon;
  tone?: StatusTone;
  // IP-WU-033: required when variant === "security-category". Drives the
  // per-category color (CodeQL and Dependabot stone, Secret amber; #1281).
  securityCategory?: SecurityCategory;
  ariaDescription?: string;
  // IP-WU-031: when provided, the chip renders as an interactive React Aria
  // Button so it can act as a re-consent trigger. Visual styling is identical.
  onPress?: () => void;
  // Optional suffix rendered inside the chip after `children`. Used to attach
  // a small "Retry" affordance after a cancelled OAuth re-consent attempt.
  actionSuffix?: ReactNode;
  "data-testid"?: string;
  // IP-WU-042: when provided, the chip wraps in a TooltipTrigger and exposes the
  // text on hover/focus. Used to surface alert severity from the cut list.
  tooltip?: string;
}

// DESIGN.md Issue chip: tinted with its own tone at the 4px chip radius. The
// four issue-* tones cover open, milestone, issue type, and label; the other
// status tones reuse the paired semantic roles (accent-muted with accent-text,
// danger-surface with danger-text). Each tone carries the hairline hover
// border in its own text hue, so a pressable chip reacts without its tint
// changing. A transparent border holds the space so the hover does not shift.
interface Tone {
  frame: string;
  hover: string;
}

const OPEN: Tone = {
  frame: "bg-issue-open text-issue-open-text",
  hover: "data-[hovered]:border-issue-open-text",
};
const ACCENT: Tone = {
  frame: "bg-accent-muted text-accent-text",
  hover: "data-[hovered]:border-accent-text",
};
const DANGER: Tone = {
  frame: "bg-danger-surface text-danger-text",
  hover: "data-[hovered]:border-danger-text",
};
const QUIET: Tone = {
  frame: "bg-bg-hover text-text-secondary",
  hover: "data-[hovered]:border-text-secondary",
};
const NEUTRAL: Tone = {
  frame: "bg-bg-pressed text-text-body",
  hover: "data-[hovered]:border-text-body",
};

const STATUS_TONES: Record<StatusTone, Tone> = {
  open: OPEN,
  "in-progress": ACCENT,
  blocked: DANGER,
  done: QUIET,
  neutral: NEUTRAL,
  warning: ACCENT,
};

const SECURITY_CATEGORY_TONES: Record<SecurityCategory, Tone> = {
  codeql: NEUTRAL,
  "secret-scanning": ACCENT,
  dependabot: NEUTRAL,
};

const VARIANT_TONES: Record<Exclude<IssueChipVariant, "status" | "security-category">, Tone> = {
  label: {
    frame: "border-issue-label-border text-issue-label-text bg-transparent",
    hover: "data-[hovered]:border-issue-label-text",
  },
  milestone: {
    frame: "bg-issue-milestone text-issue-milestone-text",
    hover: "data-[hovered]:border-issue-milestone-text",
  },
  "issue-type": {
    frame: "bg-issue-type text-issue-type-text",
    hover: "data-[hovered]:border-issue-type-text",
  },
  metadata: NEUTRAL,
};

const BASE_CLASSES =
  "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-chip border border-transparent text-11 font-medium leading-none max-w-full min-w-0";
const INTERACTIVE_CLASSES = `cursor-pointer transition-colors ${focusRing}`;

export default function IssueChip({
  variant,
  children,
  icon: Icon,
  tone = "neutral",
  securityCategory,
  ariaDescription,
  onPress,
  actionSuffix,
  "data-testid": dataTestid,
  tooltip,
}: IssueChipProps) {
  const toneClasses = toneForVariant(variant, tone, securityCategory);
  const variantClasses = toneClasses.frame;
  const showIcon = Icon !== undefined && variant !== "label";
  const generatedId = useId();
  const describedById = ariaDescription ? `chip-desc-${generatedId}` : undefined;

  const inner = (
    <>
      {showIcon && Icon ? <Icon size={12} aria-hidden="true" /> : null}
      <span className="truncate min-w-0">{children}</span>
      {actionSuffix}
      {ariaDescription ? (
        <span id={describedById} className="sr-only">
          {ariaDescription}
        </span>
      ) : null}
    </>
  );

  if (onPress) {
    return (
      <Button
        onPress={onPress}
        className={`${BASE_CLASSES} ${variantClasses} ${toneClasses.hover} ${INTERACTIVE_CLASSES}`}
        data-chip-category={variant}
        aria-describedby={describedById}
        data-testid={dataTestid}
      >
        {inner}
      </Button>
    );
  }

  if (tooltip) {
    return (
      <TooltipTrigger delay={500}>
        <Button
          className={`${BASE_CLASSES} ${variantClasses} ${toneClasses.hover} ${INTERACTIVE_CLASSES}`}
          data-chip-category={variant}
          aria-describedby={describedById}
          data-testid={dataTestid}
        >
          {inner}
        </Button>
        <Tooltip>{tooltip}</Tooltip>
      </TooltipTrigger>
    );
  }

  return (
    <span
      className={`${BASE_CLASSES} ${variantClasses}`}
      data-chip-category={variant}
      aria-describedby={describedById}
      data-testid={dataTestid}
    >
      {inner}
    </span>
  );
}

function toneForVariant(
  variant: IssueChipVariant,
  tone: StatusTone,
  securityCategory: SecurityCategory | undefined,
): Tone {
  switch (variant) {
    case "status":
      return STATUS_TONES[tone];
    case "security-category":
      return SECURITY_CATEGORY_TONES[securityCategory ?? "codeql"];
    default:
      return VARIANT_TONES[variant];
  }
}
