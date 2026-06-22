import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { GateSplitPart } from "../lib/api";

// React Query hooks for the verify-gate state (#702, FR-012). Gates are
// PROJECT-level (their plan + results are read from the registered project's
// repoPath under each gate's own spec slug), so the query keys are namespaced by
// projectId, not by bench. The conventions mirror useTestbenchPlan.ts: stable
// tuple query keys, `retry: false` (a gate read either resolves or is a real
// error, e.g. a 404 for an unknown gate id, that should surface immediately, not
// be retried), and an `enabled` gate so the caller can defer the fetch.

export function gatesQueryKey(projectId: string) {
  return ["gates", projectId] as const;
}

export function gateQueryKey(projectId: string, gateId: string) {
  return ["gate", projectId, gateId] as const;
}

// List one GateState per verify unit across the project's specs (FR-001: one
// gate per phase). An empty array is a normal response (no gates yet).
export function useGates(projectId: string, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: gatesQueryKey(projectId),
    queryFn: () => api.fetchGates(projectId),
    retry: false,
    enabled,
  });
}

// Load one gate's evaluated state. The batch view re-fetches this after a mark
// write so the gate-state panel live-updates (AC2): see
// `invalidateGate` below, which the mark mutation's caller triggers.
export function useGate(projectId: string, gateId: string, options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: gateQueryKey(projectId, gateId),
    queryFn: () => api.fetchGate(projectId, gateId),
    retry: false,
    enabled,
  });
}

// Imperatively invalidate the gate + gates queries so the panel re-evaluates
// after a mark write (AC2). The mark mutation lives in useTestbenchMarks and is
// keyed by bench, so rather than couple that hook to gate identity, the batch
// view calls this on each mark's settle to refresh the open gate's state (and
// the overview list). React Query invalidation is the load-bearing live-update
// path; SSE push is explicitly out of scope (#702).
export function useInvalidateGates() {
  const queryClient = useQueryClient();
  return {
    invalidateGate(projectId: string, gateId: string) {
      queryClient.invalidateQueries({ queryKey: gateQueryKey(projectId, gateId) });
      queryClient.invalidateQueries({ queryKey: gatesQueryKey(projectId) });
    },
    invalidateGates(projectId: string) {
      queryClient.invalidateQueries({ queryKey: gatesQueryKey(projectId) });
    },
  };
}

// Operator merge (#703, FR-002, AC1). On success the combined gate replaces its
// sources, so the gates list is invalidated to re-render the overview. The
// server rejects a signed-off (passed) gate with a 409 ApiError (AC3), which the
// caller surfaces.
export function useMergeGates(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (gateIds: string[]) => api.mergeGates(projectId, gateIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gatesQueryKey(projectId) });
    },
  });
}

// Operator split (#703, FR-002, AC2). On success two or more parts replace the
// source gate; the gates list is invalidated. The server rejects a signed-off
// gate (409) and a non-partitioning assignment (400).
export function useSplitGate(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { gateId: string; parts: GateSplitPart[] }) =>
      api.splitGate(projectId, vars.gateId, vars.parts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gatesQueryKey(projectId) });
    },
  });
}

// Reset all operator regroupings (#703); the effective gates revert to the
// externally-authored work-units.json gates.
export function useResetGateOverrides(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.resetGateOverrides(projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: gatesQueryKey(projectId) });
    },
  });
}
