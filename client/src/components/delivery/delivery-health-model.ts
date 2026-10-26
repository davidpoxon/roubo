import type { DeliveryHealthView, DeliveryHealthWord } from "@roubo/shared/delivery-selectors";
import type { StatusTone } from "../ui/styles";

// What the Delivery tab's rail and its Health chip draw (SB-FR-019,
// SB-NFR-006), worked out from the shared health selector. Pure, so the
// component module exports components only.

// How often the rail reads the clock again.
export const DELIVERY_HEALTH_TICK_MS = 5_000;

// DESIGN.md Health chip: stale takes `status-preparing`, disconnected and
// blocked take `status-error`.
export const HEALTH_TONES: Record<DeliveryHealthWord, StatusTone> = {
  fresh: "active",
  stale: "preparing",
  disconnected: "error",
  blocked: "error",
};

// The chip's label always carries the word; a blocked delivery also names the
// jammed units.
export function healthLabel(health: DeliveryHealthView): string {
  if (health.word === "blocked") {
    return `blocked · ${health.jammed.join(", ")} jammed`;
  }
  return health.word;
}

// An age as the rail writes it: seconds under a minute, then minutes, then
// hours and minutes.
export function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}
