import { useState, useEffect } from "react";

function formatElapsed(startMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - startMs) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

export function useElapsed(timestamp: string | undefined, active = true): string | null {
  const [elapsed, setElapsed] = useState<string | null>(() => {
    if (!timestamp || !active) return null;
    return formatElapsed(new Date(timestamp).getTime(), Date.now());
  });

  useEffect(() => {
    if (!timestamp || !active) return;
    const startMs = new Date(timestamp).getTime();
    const update = () => setElapsed(formatElapsed(startMs, Date.now()));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [timestamp, active]);

  if (!timestamp || !active) return null;
  return elapsed;
}
