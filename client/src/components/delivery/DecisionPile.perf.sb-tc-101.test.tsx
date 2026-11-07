// @vitest-environment jsdom
/// <reference types="node" />
// References node types for the `process.env` perf-harness flag below; the client
// tsconfig pins `types: ["vite/client"]`, so @types/node is not otherwise in scope
// for this file.
/**
 * SB-TC-101 / SB-NFR-010: the decision pile renders 100 cards in under 200 ms
 * at the median and at p95.
 *
 * The record is in auto mode with an open review, and its 100 agent decisions
 * are decided and unreviewed, oldest first: the shape the review stack reads.
 * The pile is rendered straight from the folded snapshot, so the measured cost
 * is the pile's selectors and its render (one live top card and 99 title bars).
 * The clock stops when render() returns (it is act()-wrapped, so the commit is
 * complete); the check that every card painted runs after the sample, with a
 * plain selector. WARMUP_ITERATIONS unmeasured renders come first, then the
 * measured iterations, an inline median and p95, and the budget assertion.
 *
 * Unlike the repo's other budget harnesses, the budget assertion runs in the
 * default suite, not behind RUN_PERF_HARNESS=1: the case's verify gate reads the
 * default run's JUnit report, so a gated assertion would leave it no evidence.
 * The measured headroom is more than 10x (a median near 9 ms, a p95 near 17 ms),
 * so the wall-clock assertion is not a flake risk at this budget. The
 * perf-evidence log prints only under RUN_PERF_HARNESS=1 (`npm run test:perf`),
 * so the default run stays silent. A structural test also pins that the
 * 100-card pile paints every card with the oldest on top; it asserts no budget,
 * so its name carries no case id. The numbers are jsdom render times, not
 * real-browser paint times.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import {
  AGENT_AUTHOR,
  type DeliveryDecision,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { foldDelivery, type DeliverySnapshot } from "@roubo/shared/delivery-reducer";
import { fourUnitRecord } from "../../test/delivery-fixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import DecisionPile from "./DecisionPile";

const LOG_EVIDENCE = process.env.RUN_PERF_HARNESS === "1";
const CARD_COUNT = 100;
const ITERATIONS = 20;
const WARMUP_ITERATIONS = 5;
const BUDGET_MS = 200;
const OPTIONS = ["one file per unit", "one file per stack"];
const UNITS = ["A", "B", "C", "D"];

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function decisionId(index: number): string {
  return `agent-choice-${String(index + 1).padStart(3, "0")}`;
}

// An agent decision the session took on its own in auto mode, not yet reviewed.
function agentDecision(index: number): DeliveryDecision {
  const at = new Date(Date.UTC(2026, 9, 16, 10, 0, index)).toISOString();
  return {
    id: decisionId(index),
    question: `Which layout for choice ${index + 1}?`,
    options: OPTIONS,
    default: OPTIONS[0],
    status: "decided",
    unit_id: UNITS[index % UNITS.length],
    raised_at: at,
    author: AGENT_AUTHOR,
    chosen: OPTIONS[1],
    rationale: `Rationale of choice ${index + 1}.`,
    affected_units: ["B", "C"],
    review: { status: "unreviewed" },
    decided_at: at,
  };
}

// The four-unit record in auto mode, at an open review of 100 agent decisions.
function hundredCardRecord(): DeliveryRecord {
  const decisions = Array.from({ length: CARD_COUNT }, (_, index) => agentDecision(index));
  return {
    ...fourUnitRecord(),
    mode: { value: "auto", pending: null },
    review: { status: "open", unreviewed: decisions.map((decision) => decision.id) },
    decisions,
  };
}

function paintedCards(root: HTMLElement): number {
  return root.querySelectorAll('[data-testid^="review-card-"]').length;
}

function topCardId(root: HTMLElement): string | null | undefined {
  return root.querySelector('[data-position="top"]')?.getAttribute("data-testid");
}

function pile(snapshot: DeliverySnapshot) {
  return <DecisionPile projectId="demo" benchId={3} snapshot={snapshot} />;
}

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

function benchmarkPile() {
  const snapshot = foldDelivery({ record: hundredCardRecord(), events: [] });

  for (let i = 0; i < WARMUP_ITERATIONS; i++) renderWithProviders(pile(snapshot)).unmount();
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const view = renderWithProviders(pile(snapshot));
    samples.push(performance.now() - t0);
    expect(paintedCards(view.container)).toBe(CARD_COUNT);
    view.unmount();
  }

  const medianMs = percentile(samples, 0.5);
  const p95Ms = percentile(samples, 0.95);
  if (LOG_EVIDENCE) {
    console.log(
      JSON.stringify({
        kind: "perf-evidence",
        tc: "SB-TC-101",
        cardCount: CARD_COUNT,
        iterations: ITERATIONS,
        warmupIterations: WARMUP_ITERATIONS,
        medianMs,
        p95Ms,
        budgetMs: BUDGET_MS,
      }),
    );
  }

  expect(medianMs).toBeLessThan(BUDGET_MS);
  expect(p95Ms).toBeLessThan(BUDGET_MS);
}

it(
  "SB-TC-101 renders the decision pile with 100 cards under 200 ms at the median and p95",
  benchmarkPile,
  120_000,
);

describe("decision pile with 100 unreviewed agent decisions", () => {
  it("paints every card, with the oldest on top and the rest as title bars", () => {
    const snapshot = foldDelivery({ record: hundredCardRecord(), events: [] });
    const view = renderWithProviders(pile(snapshot));
    expect(paintedCards(view.container)).toBe(CARD_COUNT);
    expect(topCardId(view.container)).toBe(`review-card-${decisionId(0)}`);
    expect(view.container.querySelectorAll('[data-position="lower"]')).toHaveLength(CARD_COUNT - 1);
  });
});
