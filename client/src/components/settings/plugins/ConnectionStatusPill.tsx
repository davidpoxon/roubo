import type { ConnectionState, ConnectionStatus } from "@roubo/shared";
import { AlertTriangle, Circle, Key, Minus, Slash } from "lucide-react";
import type { ComponentType } from "react";
import { Button, Tooltip, TooltipTrigger } from "react-aria-components";

const LABELS: Record<ConnectionState, string> = {
  connected: "Connected",
  disconnected: "Not connected",
  "auth-problem": "Sign in again",
  errored: "Error",
  disabled: "Disabled",
};

const TIMESTAMP_STRINGS = {
  rechecking: "rechecking...",
  asOf: (hh: string, mm: string) => `as of ${hh}:${mm}`,
};

const ARIA_LABELS = {
  withDetail: (label: string, detail: string) => `${label}: ${detail}`,
};

type IconProps = { size?: number; "aria-hidden"?: boolean; fill?: string };

const ICONS: Record<ConnectionState, ComponentType<IconProps>> = {
  connected: Circle,
  disconnected: Slash,
  "auth-problem": Key,
  errored: AlertTriangle,
  disabled: Minus,
};

// Every fg/bg pair below clears WCAG 2.1 AA (4.5:1) contrast at 12px/normal, which
// is not "large text", so the 3:1 large-text allowance does not apply (NFR-016).
// The solid variants keep near-white text on a darkened brand background; the muted
// stone variants keep dark-on-light text one step darker than the eye-catching tint.
const WRAP_STYLES: Record<ConnectionState, string> = {
  connected: "bg-emerald-700 text-emerald-50",
  disconnected: "bg-stone-300 text-stone-700 dark:bg-stone-700 dark:text-stone-200",
  "auth-problem": "bg-amber-500 text-amber-950",
  errored: "bg-red-700 text-red-50",
  disabled: "bg-stone-200 text-stone-600 dark:bg-stone-800 dark:text-stone-400",
};

const PILL_BASE =
  "inline-flex items-center gap-1 rounded-full h-[22px] px-1.5 text-[12px] font-medium leading-none select-none";

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return TIMESTAMP_STRINGS.asOf(hh, mm);
}

function PillBody({
  state,
  checkedAt,
  rechecking,
}: {
  state: ConnectionState;
  checkedAt?: string;
  rechecking: boolean;
}) {
  const Icon = ICONS[state];
  const showTimestamp = state !== "disabled";
  // The `connected` dot is a filled circle; other variants render outline glyphs.
  const iconExtra = state === "connected" ? { fill: "currentColor" } : {};
  const timestampText = rechecking
    ? TIMESTAMP_STRINGS.rechecking
    : checkedAt
      ? formatTimestamp(checkedAt)
      : "";
  return (
    <>
      <Icon size={12} aria-hidden {...iconExtra} />
      <span>{LABELS[state]}</span>
      {showTimestamp && timestampText && (
        <span
          data-testid="connection-status-pill-timestamp"
          className={`ml-2 text-[10px] opacity-80 ${rechecking ? "animate-pulse" : ""}`}
        >
          {timestampText}
        </span>
      )}
    </>
  );
}

export interface ConnectionStatusPillProps {
  status: ConnectionStatus;
  /**
   * When true (and not `disabled`), the trailing timestamp is replaced by a
   * pulsing "rechecking..." text. Caller owns the re-check lifecycle; the pill
   * just reflects this flag.
   */
  rechecking?: boolean;
}

export default function ConnectionStatusPill({
  status,
  rechecking = false,
}: ConnectionStatusPillProps) {
  const { state, detail, checkedAt } = status;
  const effectiveRechecking = rechecking && state !== "disabled";
  const hasTooltip =
    (state === "auth-problem" || state === "errored") &&
    typeof detail === "string" &&
    detail.length > 0;

  const className = `${PILL_BASE} ${WRAP_STYLES[state]}`;

  if (hasTooltip) {
    // Focusable wrapper so the tooltip is reachable by keyboard (NFR-016) as
    // well as hover. The Button has no onPress; it is purely a tooltip target.
    return (
      <TooltipTrigger delay={500}>
        <Button
          data-testid="connection-status-pill"
          data-state={state}
          aria-label={ARIA_LABELS.withDetail(LABELS[state], detail)}
          className={`${className} outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950`}
        >
          <PillBody state={state} checkedAt={checkedAt} rechecking={effectiveRechecking} />
        </Button>
        <Tooltip
          data-testid="connection-status-pill-tooltip"
          className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg max-w-xs"
        >
          {detail}
        </Tooltip>
      </TooltipTrigger>
    );
  }

  return (
    <span data-testid="connection-status-pill" data-state={state} className={className}>
      <PillBody state={state} checkedAt={checkedAt} rechecking={effectiveRechecking} />
    </span>
  );
}
