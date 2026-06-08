import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { DiscoveredSpec, ManualPathValidation } from "../lib/api";

// Discovery query for the spec-picker (#418, FR-001/FR-002). Enumerates every
// contract-valid `.specifications/<slug>/test-cases.json` under the project repo.
// Gated on `enabled` so the modal only fetches while it is open (and the feature
// is on). Stale-while-revalidate keeps the list fresh across reopens.
export function useTestbenchSpecs(projectId: string, enabled: boolean) {
  return useQuery<{ specs: DiscoveredSpec[] }, Error, DiscoveredSpec[]>({
    queryKey: ["testbenchSpecs", projectId],
    queryFn: () => api.fetchSpecs(projectId),
    select: (data) => data.specs,
    enabled: enabled && projectId.length > 0,
    staleTime: 0,
  });
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
