import type { ReactNode } from "react";

export type CalloutVariant = "danger" | "success";

// DESIGN.md Callout: the inline home of danger-text. It states the cause in the
// title, then the fix in the body. The success variant swaps the three
// success-* tokens.
const VARIANT_CLASSES: Record<CalloutVariant, { frame: string; title: string }> = {
  danger: { frame: "bg-danger-surface border-danger-border", title: "text-danger-text" },
  success: { frame: "bg-success-surface border-success-border", title: "text-success-text" },
};

export interface CalloutProps {
  variant?: CalloutVariant;
  /** The cause, in the variant's text colour. */
  title?: ReactNode;
  /** The fix, in body text. */
  children?: ReactNode;
  /** Announce the callout when it appears. */
  role?: "alert" | "status";
  className?: string;
  "data-testid"?: string;
}

export default function Callout({
  variant = "danger",
  title,
  children,
  role,
  className,
  "data-testid": testId,
}: CalloutProps) {
  const tone = VARIANT_CLASSES[variant];
  return (
    <div
      role={role}
      data-testid={testId}
      className={["flex flex-col gap-1 rounded-control border p-3 text-13", tone.frame, className]
        .filter(Boolean)
        .join(" ")}
    >
      {title ? <p className={`font-medium ${tone.title}`}>{title}</p> : null}
      {children ? <div className="text-text-body">{children}</div> : null}
    </div>
  );
}
