import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { SpecLifecycleRecordInput, SpecLifecycleState } from "../lib/api";

// Spec-level lifecycle mutation for the picker (#773, SATCA-FR-020/FR-021).
// Archives or supersedes a spec, and reverses either by passing `lifecycle:
// null`, which is why one hook covers all three actions: reversal is a key
// deletion, not a separate endpoint.
//
// Deliberately NOT optimistic, unlike useTestbenchMarks. A mark is a cheap
// idempotent toggle over a cached plan; this one writes a file product-dev also
// owns and can legitimately be refused (a manifest that will not parse, a
// superseding slug naming no spec). Showing a spec as archived before the server
// has agreed would mean rendering a state that may never reach disk, so the
// picker waits for the round-trip and re-reads the authoritative list.
//
// Invalidating ["testbenchSpecs", projectId] is what moves the row between the
// live groups and the archived group: the server owns the partition inputs
// (lifecycle + verification classification), and the client never re-derives
// them.

interface SpecLifecycleVars {
  projectId: string;
  slug: string;
  lifecycle: SpecLifecycleRecordInput | null;
}

export function useSpecLifecycleMutation() {
  const queryClient = useQueryClient();
  return useMutation<SpecLifecycleState, Error, SpecLifecycleVars>({
    mutationFn: ({ projectId, slug, lifecycle }) =>
      api.setSpecLifecycle(projectId, slug, lifecycle),
    onSettled: (_data, _err, vars) => {
      queryClient.invalidateQueries({ queryKey: ["testbenchSpecs", vars.projectId] });
    },
  });
}
