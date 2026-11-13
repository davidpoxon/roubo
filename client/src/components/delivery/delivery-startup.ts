import { useEffect, useState } from "react";
import type { Bench, TerminalSession } from "@roubo/shared";
import type { StatusTone } from "../ui/styles";
import { useDeliverySession } from "../../hooks/useDelivery";
import {
  deliveryStartup,
  type DeliveryStartup,
  type DeliveryStartupPhase,
} from "./delivery-startup-model";

// What the Delivery tab's start-up panel (DeliveryStartup) and the Test bench
// tab's start-up line share: the head that names each phase, and the hook that
// reads where the start-up is.

/** The status indicator that names each phase. The Test bench tab names it too. */
export const DELIVERY_STARTUP_HEAD: Record<
  DeliveryStartupPhase,
  { tone: StatusTone; label: string }
> = {
  starting: { tone: "preparing", label: "Starting the delivery" },
  planning: { tone: "preparing", label: "Planning the delivery" },
  "awaiting-operator": { tone: "preparing", label: "Waiting for you" },
  "launch-failed": { tone: "error", label: "The delivery session did not start" },
  "launch-stalled": { tone: "idle", label: "The delivery session has not started" },
  "session-ended": { tone: "error", label: "The delivery session ended" },
  "bench-unavailable": { tone: "idle", label: "The bench is unavailable" },
  "attach-waiting": { tone: "preparing", label: "Waiting for the delivery" },
};

/**
 * How long the session step may run before the launch is offered again. The
 * create-time launch starts the session within seconds of the workspace being
 * ready; the server refuses a second launch while one is in flight (409).
 */
export const LAUNCH_GRACE_MS = 30_000;

// True once `active` has held for `ms` without a break.
function useHeldFor(active: boolean, ms: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setHeld(true), ms);
    return () => {
      clearTimeout(timer);
      setHeld(false);
    };
  }, [active, ms]);
  return active && held;
}

/**
 * Where the start-up of the bench's delivery is, with the bench's delivery
 * session, and the launch offered again once the session step has run past
 * LAUNCH_GRACE_MS. `enabled` false skips the model (the hooks still run, so the
 * caller can call it on every render); it is false while the record exists.
 */
export function useDeliveryStartup(
  bench: Bench,
  enabled = true,
): (DeliveryStartup & { session: TerminalSession | undefined }) | undefined {
  const { session, listed } = useDeliverySession(bench);
  const initial = enabled ? deliveryStartup(bench, session, { sessionListed: listed }) : undefined;
  const launchStalled = useHeldFor(
    initial?.phase === "starting" && initial.steps[1]?.status === "running",
    LAUNCH_GRACE_MS,
  );
  if (initial === undefined) return undefined;
  const state = launchStalled
    ? deliveryStartup(bench, session, { sessionListed: listed, launchStalled })
    : initial;
  return { ...state, session };
}
