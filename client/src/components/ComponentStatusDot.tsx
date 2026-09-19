import type { ComponentStatusValue } from "@roubo/shared";
import { STATUS_DOT_CLASSES, type StatusTone } from "./ui/styles";

// Component statuses onto the four DESIGN.md status tokens. Starting and
// stopping are work in progress, so they share `status-preparing` and pulse.
const COMPONENT_STATUS_TONE: Record<ComponentStatusValue, StatusTone> = {
  running: "active",
  starting: "preparing",
  stopping: "preparing",
  error: "error",
  stopped: "idle",
  completed: "active",
};

/**
 * A component's status dot. The dot never stands alone: either the caller
 * sets the status as visible text beside it (then the dot is decorative), or
 * it passes `label`, and the dot names the component and its status to
 * assistive technology.
 */
export default function ComponentStatusDot({
  status,
  label,
}: {
  status: ComponentStatusValue;
  label?: string;
}) {
  const isTransitional = status === "starting" || status === "stopping";
  const title = label ? `${label}: ${status}` : status;

  return (
    <span
      title={title}
      {...(label ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
      className={`inline-block w-2 h-2 shrink-0 rounded-full ${STATUS_DOT_CLASSES[COMPONENT_STATUS_TONE[status]]} ${
        isTransitional ? "animate-status-pulse" : ""
      } transition-colors duration-300`}
    />
  );
}
