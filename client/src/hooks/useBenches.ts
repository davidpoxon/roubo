import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";

function hasActiveOperation(benches: { status: string }[] | undefined): boolean {
  return !!benches?.some((b) => b.status === "clearing" || b.status === "preparing");
}

export function useAllBenches() {
  return useQuery({
    queryKey: ["benches"],
    queryFn: api.fetchAllBenches,
    refetchInterval: (query) => (hasActiveOperation(query.state.data) ? 1000 : 5000),
  });
}

// When projectId is undefined, intentionally fetches all benches so the dashboard
// can display a cross-project overview. This is not dormant when projectId is missing.
export function useProjectBenches(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? ["benches", projectId] : ["benches"],
    queryFn: () => (projectId ? api.fetchBenches(projectId) : api.fetchAllBenches()),
    refetchInterval: (query) => (hasActiveOperation(query.state.data) ? 1000 : 5000),
  });
}

export function useBenchDetail(projectId: string, benchId: number) {
  return useQuery({
    queryKey: ["bench", projectId, benchId],
    queryFn: () => api.fetchBench(projectId, benchId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "clearing" || status === "preparing" ? 1000 : 5000;
    },
  });
}

export function useCreateBench() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      branch,
      issueNumber,
      externalId,
      branchConflictResolution,
      variant,
      focusedSpecPath,
    }: {
      projectId: string;
      branch?: string;
      issueNumber?: number;
      externalId?: string;
      branchConflictResolution?: "resume" | "new";
      variant?: "testbench";
      focusedSpecPath?: string;
    }) =>
      api.createBench(projectId, {
        branch,
        issueNumber,
        externalId,
        branchConflictResolution,
        variant,
        focusedSpecPath,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["project-items"] });
    },
  });
}

export function useSetWorkUnitIgnored() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      submodule,
      ignored,
    }: {
      projectId: string;
      benchId: number;
      submodule: string;
      ignored: boolean;
    }) => api.setWorkUnitIgnoredForAutoClear(projectId, benchId, submodule, ignored),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}

export function useCleanupAndRetryBench() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, benchId }: { projectId: string; benchId: number }) =>
      api.cleanupAndRetryBench(projectId, benchId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}

export function useTeardownBench() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      removeWorkspace,
      force,
    }: {
      projectId: string;
      benchId: number;
      removeWorkspace?: boolean;
      force?: boolean;
    }) => api.teardownBench(projectId, benchId, removeWorkspace, force),
    onSuccess: (bench) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", bench.projectId, bench.id] });
    },
  });
}

export function useSyncBenchWorkUnits() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, benchId }: { projectId: string; benchId: number }) =>
      api.syncBenchWorkUnits(projectId, benchId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}

export function useStartBench() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, benchId }: { projectId: string; benchId: number }) =>
      api.startBench(projectId, benchId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}

export function useStopBench() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, benchId }: { projectId: string; benchId: number }) =>
      api.stopBench(projectId, benchId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}

export function useStartComponent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      component,
    }: {
      projectId: string;
      benchId: number;
      component: string;
    }) => api.startComponent(projectId, benchId, component),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}

export function useStopComponent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      component,
    }: {
      projectId: string;
      benchId: number;
      component: string;
    }) => api.stopComponent(projectId, benchId, component),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}

export function useDismissBenchNotifications() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, benchId }: { projectId: string; benchId: number }) =>
      api.dismissBenchNotifications(projectId, benchId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}

export function useDismissNotification() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      notificationId,
    }: {
      projectId: string;
      benchId: number;
      notificationId: string;
    }) => api.dismissNotification(projectId, benchId, notificationId),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["benches"] });
      queryClient.invalidateQueries({ queryKey: ["bench", vars.projectId, vars.benchId] });
    },
  });
}
