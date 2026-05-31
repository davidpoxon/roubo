import { useMemo } from "react";
import { useSettings } from "./useSettings";
import { useAllBenches } from "./useBenches";

/**
 * Derived view of the application-wide bench cap. Purely a memoized composition
 * of useSettings() and useAllBenches(): no new fetch and no new query key.
 * Centralizes the cap derivation so BenchesTab, CreateBenchModal, and (later)
 * the GlobalBenchMeter all read from one source.
 */
export interface GlobalCapState {
  /** Number of benches that currently exist across all projects. */
  current: number;
  /** Configured cap, or null when no global cap is set (unlimited). */
  max: number | null;
  /** True when a global cap is configured. */
  isCapped: boolean;
  /** True when the current count has reached or exceeded the cap. */
  isAtCap: boolean;
  /** True when the current count exceeds the cap (e.g. after lowering it). */
  isOverCap: boolean;
}

export function useGlobalCap(): GlobalCapState {
  const { settings } = useSettings();
  const { data: benches } = useAllBenches();

  return useMemo(() => {
    const current = benches?.length ?? 0;
    const max = settings?.benches?.maxGlobal ?? null;
    const isCapped = max !== null;
    return {
      current,
      max,
      isCapped,
      isAtCap: isCapped && current >= max,
      isOverCap: isCapped && current > max,
    };
  }, [benches, settings]);
}
