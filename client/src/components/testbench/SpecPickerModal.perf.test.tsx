// @vitest-environment jsdom
/// <reference types="node" />
// References node types for the `process.env` perf-harness gate below; the client
// tsconfig pins `types: ["vite/client"]`, so @types/node is not otherwise in scope
// for this file.
/**
 * TSPF-TC-016 / TSPF-NFR-002: the spec picker renders the partitioned view in
 * under 100ms (p95) after a 25-spec mixed-classification discovery payload
 * arrives.
 *
 * The specs hook is mocked to return a warm payload synchronously (modelling the
 * moment discovery data arrives), so the measured cost is exactly partitionSpecs
 * + deriveSpecSummary + the row render for the partitioned list. The budget
 * assertion is gated behind RUN_PERF_HARNESS=1 (the repo's perf convention,
 * mirroring CLI-TC-011): warmup + measured iterations, inline p95, a structured
 * perf-evidence log. A sentinel keeps the file contributing a passing assertion
 * under the default coverage run, and a non-gated structural test pins that the
 * partitioned view actually paints from the payload (so the measured render is the
 * real work, not a stub).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders } from "../../test/renderWithProviders";
import type { DiscoveredSpec, SpecVerification } from "../../lib/api";
import type { ManualPathState } from "../../hooks/useTestbenchSpecs";

const RUN = process.env.RUN_PERF_HARNESS === "1";
const SPEC_COUNT = 25;
const ITERATIONS = 20;
const P95_BUDGET_MS = 100;

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
}

// Build a verification payload with sensible defaults; each fixture states only
// the fields it needs (mirrors SpecPickerModal.test.tsx).
function verification(
  over: Partial<Omit<SpecVerification, "statusCounts">> & {
    statusCounts?: Partial<SpecVerification["statusCounts"]>;
  } = {},
): SpecVerification {
  const { statusCounts, ...rest } = over;
  return {
    classification: "needs-attention",
    resultsPresent: true,
    resultsValid: true,
    planHashMatch: true,
    recoveryReason: null,
    aggregationError: false,
    ...rest,
    statusCounts: {
      not_started: 0,
      in_progress: 0,
      passed: 0,
      failed: 0,
      blocked: 0,
      ...(statusCounts ?? {}),
    },
  };
}

// 25 mixed-classification specs, cycling the five summary shapes so the partition
// split and every deriveSpecSummary branch are exercised. i % 5 === 0 is
// all-passed (5 specs, collapsed tail); the other 20 are needs-attention.
const SPECS: DiscoveredSpec[] = Array.from({ length: SPEC_COUNT }, (_, i) => {
  const slug = `spec-${String(i).padStart(2, "0")}`;
  const specPath = `/repo/.specifications/${slug}/test-cases.json`;
  const caseCount = 3 + (i % 9);
  switch (i % 5) {
    case 0:
      // all-passed -> collapsed tail disclosure ("All M passed").
      return {
        slug,
        path: specPath,
        caseCount,
        verification: verification({
          classification: "all-passed",
          statusCounts: { passed: caseCount },
        }),
      };
    case 1:
      // no sidecar yet -> "no results yet".
      return {
        slug,
        path: specPath,
        caseCount,
        verification: verification({
          resultsPresent: false,
          resultsValid: false,
          planHashMatch: false,
          statusCounts: { not_started: caseCount },
        }),
      };
    case 2:
      // valid sidecar, hash mismatch -> "results stale".
      return {
        slug,
        path: specPath,
        caseCount,
        verification: verification({
          planHashMatch: false,
          statusCounts: { passed: caseCount },
        }),
      };
    case 3:
      // some passed, no failures -> "P of M passed" (progress).
      return {
        slug,
        path: specPath,
        caseCount,
        verification: verification({
          statusCounts: { passed: 1, in_progress: caseCount - 1 },
        }),
      };
    default:
      // some passed, with failures -> "P of M passed" + "· k failed".
      return {
        slug,
        path: specPath,
        caseCount,
        verification: verification({
          statusCounts: { passed: 1, failed: caseCount - 1 },
        }),
      };
  }
});

const mockUseTestbenchSpecs = vi.hoisted(() => vi.fn());
const mockUseManualPathValidation = vi.hoisted(() => vi.fn());

// Mock only the two data-fetching hooks; keep the real pure helpers
// (partitionSpecs / deriveSpecSummary), which are the work under measurement.
vi.mock("../../hooks/useTestbenchSpecs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useTestbenchSpecs")>();
  return {
    ...actual,
    useTestbenchSpecs: (...args: unknown[]) => mockUseTestbenchSpecs(...args),
    useManualPathValidation: (...args: unknown[]) => mockUseManualPathValidation(...args),
  };
});

import SpecPickerModal from "./SpecPickerModal";

function specsQuery(over: Partial<ReturnType<typeof mockUseTestbenchSpecs>> = {}) {
  return {
    data: { specs: SPECS, invalid: [] },
    isLoading: false,
    isError: false,
    error: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTestbenchSpecs.mockReturnValue(specsQuery());
  mockUseManualPathValidation.mockReturnValue({ status: "idle" } satisfies ManualPathState);
});

function renderModal(props: Partial<React.ComponentProps<typeof SpecPickerModal>> = {}) {
  return renderWithProviders(
    <SpecPickerModal isOpen onClose={vi.fn()} projectId="p1" onCreate={vi.fn()} {...props} />,
  );
}

describe("TSPF-TC-016: partitioned view renders from the arrived payload", () => {
  it("paints the 20 needs-attention rows in the main space and collapses the 5 all-passed", () => {
    const view = renderModal();
    // Needs-attention specs render as selectable rows (role=radio); all-passed
    // specs live behind the collapsed disclosure until it is expanded.
    expect(view.getAllByRole("radio")).toHaveLength(20);
    const disclosure = view.getByRole("button", { name: /All passed/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(view.getByText("· 5 specs")).toBeInTheDocument();
  });
});

it.runIf(RUN)(
  "TSPF-TC-016: partition + render p95 < 100ms for a 25-spec payload",
  () => {
    // Warmup render (not measured) to amortize first-render module/JIT cost.
    renderModal().unmount();

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const t0 = performance.now();
      const view = renderModal();
      // Needs-attention rows painted == the partitioned view rendered from the
      // arrived payload.
      view.getAllByRole("radio");
      samples.push(performance.now() - t0);
      view.unmount();
    }

    const p95Ms = p95(samples);
    const maxMs = Math.max(...samples);

    console.log(
      JSON.stringify(
        {
          kind: "perf-evidence",
          tc: "TSPF-TC-016",
          specCount: SPEC_COUNT,
          iterations: ITERATIONS,
          p95Ms,
          maxMs,
        },
        null,
        2,
      ),
    );

    expect(p95Ms).toBeLessThan(P95_BUDGET_MS);
  },
  120_000,
);

describe("TSPF-TC-016 harness (smoke)", () => {
  // Sentinel so the file always contributes a passing assertion under the
  // default coverage run (vitest fails files with zero discovered tests).
  it.runIf(!RUN)("perf assertion is skipped unless RUN_PERF_HARNESS=1", () => {
    expect(RUN).toBe(false);
  });
});
