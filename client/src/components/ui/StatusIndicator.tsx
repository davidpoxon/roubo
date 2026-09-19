import { STATUS_DOT_CLASSES, type StatusTone } from "./styles";

// DESIGN.md Status indicator: a dot plus its label, never the dot alone. The
// dot pulses with motion.status-pulse while work is in progress; under reduced
// motion the pulse is suppressed and the label still carries the meaning.

export interface StatusIndicatorProps {
  tone: StatusTone;
  /** The visible status text. Required: the dot never appears without it. */
  label: string;
  /** Pulse the dot. Defaults to true while `preparing`. */
  pulse?: boolean;
  className?: string;
  "data-testid"?: string;
}

export default function StatusIndicator({
  tone,
  label,
  pulse = tone === "preparing",
  className,
  "data-testid": testId,
}: StatusIndicatorProps) {
  return (
    <span
      data-testid={testId}
      data-status={tone}
      className={["inline-flex items-center gap-1.5", className].filter(Boolean).join(" ")}
    >
      <span
        aria-hidden="true"
        className={`inline-block w-2 h-2 shrink-0 rounded-full ${STATUS_DOT_CLASSES[tone]} ${
          pulse ? "animate-status-pulse" : ""
        }`}
      />
      <span className="text-11 font-medium text-text-secondary">{label}</span>
    </span>
  );
}
