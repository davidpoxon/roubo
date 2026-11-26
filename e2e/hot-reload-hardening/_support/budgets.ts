// Shared by the hot-reload hardening cases (HR-TC-048, HR-TC-049, HR-TC-051).
// Each takes minutes or asserts a wall-clock budget, so it runs only when
// ROUBO_E2E_HARDENING=1: the nightly perf workflow sets it, and a plain
// `playwright test` skips the cases with this reason.

export const HARDENING_ENABLED = process.env.ROUBO_E2E_HARDENING === "1";

export const HARDENING_SKIP_REASON =
  "a hot-reload hardening case: set ROUBO_E2E_HARDENING=1 to run it (the nightly perf workflow does)";

/** The p-th percentile of `samples`, nearest rank. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * A positive integer from the environment, or `fallback` when the variable is
 * unset. A value that is set but not a positive integer, or above `max`, is an error, so a typo
 * never quietly runs the default.
 */
export function positiveIntFromEnv(
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, not ${JSON.stringify(raw)}`);
  }
  if (value > max) {
    throw new Error(`${name} must be at most ${max}, not ${value}`);
  }
  return value;
}
