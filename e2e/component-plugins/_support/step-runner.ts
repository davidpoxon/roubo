import { expect } from "@playwright/test";

// FR-020 failure-output contract (issue #626, CP-TC-028).
//
// The component-plugin e2e is the integration-level drift guard for the
// "author publishes a component plugin" journey. It spans eight slices
// (#598, #600, #602, #603, #604, #605, #607, #613) plus the bench-manager ->
// engine dispatch removal (#612, OPEN at the time of writing). When an
// observation diverges from CP-TC-028's expected result, the failure message
// must localise the drift to an attributable slice so an integration break is
// not a vague red X: it must report (1) which e2e_flow step diverged, (2) the
// expected-vs-actual at that step, and (3) the owning slice issue(s).
//
// This module is the producer side of that contract: every CP-TC-028 step is
// declared with its id, instruction, and the slice issues that own it, and an
// assertion that fails routes through `attribute()` so the thrown error carries
// the full attribution block.

/** One slice issue from this unit's blocked-by / dispatch set. */
export interface OwningSlice {
  issue: number;
  title: string;
}

/** A single ordered, attributable CP-TC-028 step. */
export interface JourneyStep {
  id: string;
  instruction: string;
  /** The slice issue(s) that own the behaviour this step observes. */
  owners: OwningSlice[];
}

/**
 * Format the FR-020 failure block for a diverged observation. Surfaced verbatim
 * in the Playwright failure message so the owning slice is one read away.
 */
export function formatDivergence(
  step: JourneyStep,
  observationId: string,
  expected: string,
  actual: string,
): string {
  const owners = step.owners.map((o) => `#${o.issue} (${o.title})`).join(", ");
  return [
    "",
    "CP-TC-028 drift detected (FR-020 failure-output contract):",
    `  diverged step:  ${step.id} ${observationId} - ${step.instruction}`,
    `  expected:       ${expected}`,
    `  actual:         ${actual}`,
    `  owning slice(s): ${owners}`,
    "",
  ].join("\n");
}

/**
 * Assert one CP-TC-028 observation. On failure the thrown message carries the
 * FR-020 attribution block (step + expected/actual + owning slices). `actual`
 * is rendered into the divergence block; the boolean `ok` decides pass/fail so
 * the caller keeps full control of the comparison.
 */
export function observe(
  step: JourneyStep,
  observationId: string,
  ok: boolean,
  expected: string,
  actual: string,
): void {
  expect(ok, formatDivergence(step, observationId, expected, actual)).toBe(true);
}
