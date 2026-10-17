import type { Bench } from "@roubo/shared";

// DESIGN.md Bench card, head > variant: a Spec Bench names itself with a badge,
// `accent-text` on `accent-muted`. A normal bench carries none, so this renders
// nothing for it.
const LABELS: Partial<Record<NonNullable<Bench["variant"]>, string>> = {
  specbench: "Spec Bench",
};

export default function VariantBadge({
  variant,
  className = "",
}: {
  variant: Bench["variant"];
  className?: string;
}) {
  const label = variant === undefined ? undefined : LABELS[variant];
  if (label === undefined) return null;
  return (
    <span
      data-testid="bench-variant-badge"
      className={`inline-flex items-center px-1.5 py-0.5 rounded-chip text-11 font-medium bg-accent-muted text-accent-text ${className}`}
    >
      {label}
    </span>
  );
}
