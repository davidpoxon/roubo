import type { Bench } from "@roubo/shared";

// DESIGN.md Bench card, head > variant: a Spec Bench names itself with a badge,
// `accent-text` on `accent-muted`. A normal bench carries none, so this renders
// nothing for it. A Spec Bench in auto mode adds the mode, as in
// `Spec Bench · auto` (SB-FR-031).
const LABELS: Partial<Record<NonNullable<Bench["variant"]>, string>> = {
  specbench: "Spec Bench",
};

export default function VariantBadge({
  variant,
  decisionMode,
  className = "",
}: {
  variant: Bench["variant"];
  decisionMode?: Bench["deliveryDecisionMode"];
  className?: string;
}) {
  const base = variant === undefined ? undefined : LABELS[variant];
  if (base === undefined) return null;
  const label = variant === "specbench" && decisionMode === "auto" ? `${base} · auto` : base;
  return (
    <span
      data-testid="bench-variant-badge"
      className={`inline-flex items-center px-1.5 py-0.5 rounded-chip text-11 font-medium bg-accent-muted text-accent-text ${className}`}
    >
      {label}
    </span>
  );
}
