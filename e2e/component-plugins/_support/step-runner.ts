import { expect } from "@playwright/test";

// FR-020 failure-output contract (shared across the component-plugin e2e drift
// guards).
//
// A component-plugin e2e is the integration-level drift guard for a primary
// user journey that spans several slices. When an observation diverges from the
// authoritative e2e_flow case, the failure message must localise the drift to an
// attributable slice so an integration break is not a vague red X: it must
// report (1) which e2e_flow step diverged, (2) the expected-vs-actual at that
// step, and (3) the owning slice issue(s).
//
// This module is the producer side of that contract. Each step is declared with
// its id, instruction, and the slice issues that own it; an assertion that fails
// routes through the observer returned by `makeObserve`, so the thrown error
// carries the full attribution block. The journey/case id (e.g. "CP-TC-028",
// "CPHM-TC-081") is bound per spec so each guard's failures name their own case
// rather than a hardcoded one.

/** One slice issue from a unit's blocked-by / dispatch set. */
export interface OwningSlice {
  issue: number;
  title: string;
}

/** A single ordered, attributable journey step. */
export interface JourneyStep {
  id: string;
  instruction: string;
  /** The slice issue(s) that own the behaviour this step observes. */
  owners: OwningSlice[];
}

/**
 * Format the FR-020 failure block for a diverged observation. Surfaced verbatim
 * in the Playwright failure message so the owning slice is one read away. The
 * `journeyId` labels the header so each guard's failures name their own case.
 */
export function formatDivergence(
  journeyId: string,
  step: JourneyStep,
  observationId: string,
  expected: string,
  actual: string,
): string {
  const owners = step.owners.map((o) => `#${o.issue} (${o.title})`).join(", ");
  return [
    "",
    `${journeyId} drift detected (FR-020 failure-output contract):`,
    `  diverged step:  ${step.id} ${observationId} - ${step.instruction}`,
    `  expected:       ${expected}`,
    `  actual:         ${actual}`,
    `  owning slice(s): ${owners}`,
    "",
  ].join("\n");
}

/**
 * Assert one journey observation. On failure the thrown message carries the
 * FR-020 attribution block (step + expected/actual + owning slices). `actual`
 * is rendered into the divergence block; the boolean `ok` decides pass/fail so
 * the caller keeps full control of the comparison.
 */
export type Observer = (
  step: JourneyStep,
  observationId: string,
  ok: boolean,
  expected: string,
  actual: string,
) => void;

/**
 * Bind an {@link Observer} to a journey/case id. Each spec calls this once with
 * its own case id (e.g. `makeObserve("CPHM-TC-081")`) so its divergence blocks
 * read that case, keeping the shared contract's header parameterised rather than
 * hardcoded to a single guard.
 */
export function makeObserve(journeyId: string): Observer {
  return (step, observationId, ok, expected, actual) => {
    expect(ok, formatDivergence(journeyId, step, observationId, expected, actual)).toBe(true);
  };
}
