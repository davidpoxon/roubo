import { useEffect, useState } from "react";

/**
 * The wall clock in epoch milliseconds, read again every `intervalMs`. A view
 * that shows an age or a staleness re-renders on it, so a delivery that goes
 * quiet turns stale without any new data arriving (SB-NFR-006).
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
