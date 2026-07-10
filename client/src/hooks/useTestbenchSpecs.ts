import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { DiscoveredSpec, InvalidSpec, ManualPathValidation } from "../lib/api";

// Discovery query for the spec-picker (#418, FR-001/FR-002). Enumerates every
// `.specifications/<slug>/test-cases.json` under the project repo, returning both
// the usable `specs` and any present-but-invalid spec files (`invalid`) with their
// validation errors, so the picker can distinguish a schema mismatch from a
// genuinely empty project. Gated on `enabled` so the modal only fetches while it
// is open (and the feature is on). Stale-while-revalidate keeps the list fresh
// across reopens.
export function useTestbenchSpecs(projectId: string, enabled: boolean) {
  return useQuery<{ specs: DiscoveredSpec[]; invalid: InvalidSpec[] }, Error>({
    queryKey: ["testbenchSpecs", projectId],
    queryFn: () => api.fetchSpecs(projectId),
    enabled: enabled && projectId.length > 0,
    staleTime: 0,
  });
}

// The partition the spec picker renders (#483, TSPF-FR-003): needs-attention
// specs get the prominent main space, all-passed specs the collapsed tail
// disclosure. Keyed SOLELY on `verification.classification` (the server owns the
// classification; the client never re-derives it), and stable: input order is
// preserved within each group so the server's slug sort survives the split.
export function partitionSpecs(specs: DiscoveredSpec[]): {
  needsAttention: DiscoveredSpec[];
  allPassed: DiscoveredSpec[];
} {
  const needsAttention: DiscoveredSpec[] = [];
  const allPassed: DiscoveredSpec[] = [];
  for (const spec of specs) {
    if (spec.verification.classification === "all-passed") {
      allPassed.push(spec);
    } else {
      needsAttention.push(spec);
    }
  }
  return { needsAttention, allPassed };
}

// The visual marker a pass-state summary leads with (#483, TSPF-FR-006). Each
// maps to a specific dot or icon in the row; the accompanying text is always
// present, so meaning is never carried by colour alone.
//   - "none":     hollow stone dot   (no results yet)
//   - "stale":    amber triangle     (results stale)
//   - "passed":   green dot          (all cases passed)
//   - "progress": amber dot          (some passed, no failures)
//   - "failed":   red dot            (some passed, with failures)
export type SpecSummaryMarker = "none" | "stale" | "passed" | "progress" | "failed";

// A small, render-agnostic descriptor for a spec's pass-state summary line. The
// component maps `marker` to a dot/icon and renders `text`; when `failed > 0` it
// appends a red "· k failed" fragment (only the "failed" marker ever carries a
// non-zero count).
export interface SpecPassSummary {
  marker: SpecSummaryMarker;
  text: string;
  failed: number;
}

// Derive a spec's pass-state summary purely from its verification payload and
// case count (#483, TSPF-FR-006). Precedence mirrors the approved prototype
// (.specifications/testbench-spec-picker-filter/design-prototype/index.html):
//   1. no sidecar on disk           -> "no results yet"
//   2. valid sidecar, hash mismatch -> "results stale"
//   3. classification all-passed    -> "All M passed"
//   4. otherwise                    -> "P of M passed" (+ "k failed" when failures exist)
export function deriveSpecSummary(spec: DiscoveredSpec): SpecPassSummary {
  const v = spec.verification;
  if (!v.resultsPresent) {
    return { marker: "none", text: "no results yet", failed: 0 };
  }
  if (v.resultsValid && !v.planHashMatch) {
    return { marker: "stale", text: "results stale", failed: 0 };
  }
  if (v.classification === "all-passed") {
    return { marker: "passed", text: `All ${spec.caseCount} passed`, failed: 0 };
  }
  const failed = v.statusCounts.failed;
  return {
    marker: failed > 0 ? "failed" : "progress",
    text: `${v.statusCounts.passed} of ${spec.caseCount} passed`,
    failed,
  };
}

// The four named states the manual-path input cycles through (FR-003):
//   - idle:       no path entered yet (or just cleared)
//   - validating: a debounced request is in flight
//   - valid:      the path resolved to a contract-valid spec
//   - invalid:    the path was rejected (escapes repo, wrong shape, schema-invalid)
export type ManualPathState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "valid"; slug: string; caseCount: number; path: string }
  | { status: "invalid"; errors: string[] };

const DEBOUNCE_MS = 300;

// The resolved (valid/invalid) outcome for a specific trimmed path. Only the async
// result is stored in state; the idle/validating phases are derived synchronously
// from the inputs so the effect never calls setState directly in its body.
type ResolvedOutcome =
  | { status: "valid"; slug: string; caseCount: number; path: string }
  | { status: "invalid"; errors: string[] };

// Live, debounced validation for the manual-path escape hatch. Returns the current
// named state; the caller drives it by passing the raw input value plus whether the
// modal is open (so validation pauses while closed). A trailing debounce avoids a
// request per keystroke, and an in-flight-request guard discards stale responses so
// the last keystroke always wins.
export function useManualPathValidation(
  projectId: string,
  rawPath: string,
  enabled: boolean,
): ManualPathState {
  const trimmed = rawPath.trim();
  const active = enabled && trimmed.length > 0;

  // Stores only the async outcome, keyed by the path it was computed for, so a
  // stale outcome for an earlier path is never shown for the current input.
  const [resolved, setResolved] = useState<{ path: string; outcome: ResolvedOutcome } | null>(null);
  // Monotonic request id: a response is only applied if it is the latest request,
  // so a slow earlier response cannot clobber a newer one.
  const latestRequestId = useRef(0);

  useEffect(() => {
    if (!active) {
      latestRequestId.current += 1; // cancel any pending apply
      return;
    }

    const requestId = ++latestRequestId.current;
    const timer = setTimeout(() => {
      api
        .validateSpecPath(projectId, trimmed)
        .then((result: ManualPathValidation) => {
          if (requestId !== latestRequestId.current) return;
          setResolved({
            path: trimmed,
            outcome: result.ok
              ? { status: "valid", slug: result.slug, caseCount: result.caseCount, path: trimmed }
              : { status: "invalid", errors: result.errors },
          });
        })
        .catch((err: unknown) => {
          if (requestId !== latestRequestId.current) return;
          setResolved({
            path: trimmed,
            outcome: {
              status: "invalid",
              errors: [err instanceof Error ? err.message : "Validation failed"],
            },
          });
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [projectId, trimmed, active]);

  // Derive the displayed state from the inputs + the last resolved outcome. While a
  // path has changed but its result has not arrived yet, we are validating.
  if (!active) return { status: "idle" };
  if (resolved && resolved.path === trimmed) return resolved.outcome;
  return { status: "validating" };
}
