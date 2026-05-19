import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";
import type { BlueprintCreateRequest, BlueprintUpdateRequest } from "@roubo/shared";
import * as api from "../lib/api";
import { deriveDuplicateName } from "../lib/duplicateBlueprintName";

function requireProjectId(projectId: string | undefined): string {
  if (!projectId) {
    throw new Error("projectId is required");
  }
  return projectId;
}

export function useGlobalBlueprints() {
  return useQuery({
    queryKey: ["blueprints", "global"],
    queryFn: () => api.fetchGlobalBlueprints(),
    staleTime: 60_000,
  });
}

export function useBlueprints(projectId: string | undefined) {
  return useQuery({
    queryKey: ["blueprints", "project", projectId],
    queryFn: () => api.fetchBlueprints(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useGlobalBlueprint(blueprintId: string | undefined) {
  return useQuery({
    queryKey: ["blueprints", "global", blueprintId],
    queryFn: () => api.fetchGlobalBlueprint(blueprintId as string),
    enabled: !!blueprintId && blueprintId !== GLOBAL_DEFAULT_BLUEPRINT_ID,
    staleTime: 30_000,
  });
}

export function useProjectBlueprint(
  projectId: string | undefined,
  blueprintId: string | undefined,
) {
  return useQuery({
    queryKey: ["blueprints", "project", projectId, blueprintId],
    queryFn: () => api.fetchBlueprint(projectId as string, blueprintId as string),
    enabled: !!projectId && !!blueprintId && blueprintId !== GLOBAL_DEFAULT_BLUEPRINT_ID,
    staleTime: 30_000,
  });
}

export function useCreateGlobalBlueprint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BlueprintCreateRequest) => api.createGlobalBlueprint(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "global"],
      });
    },
  });
}

export function useUpdateGlobalBlueprint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: BlueprintUpdateRequest }) =>
      api.updateGlobalBlueprint(id, body),
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "global"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "global", id],
      });
    },
  });
}

export function useDeleteGlobalBlueprint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteGlobalBlueprint(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "global"],
      });
    },
  });
}

export function useDuplicateGlobalBlueprint() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const [blueprints, detail] = await Promise.all([
        api.fetchGlobalBlueprints(),
        api.fetchGlobalBlueprint(id),
      ]);
      const name = deriveDuplicateName(
        detail.name,
        blueprints.map((b) => b.name),
      );

      return api.createGlobalBlueprint({
        name,
        description: detail.description,
        icon: detail.icon,
        content: detail.content,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "global"],
      });
    },
  });
}

export function useCreateProjectBlueprint(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BlueprintCreateRequest) =>
      api.createProjectBlueprint(requireProjectId(projectId), body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "project", projectId],
      });
    },
  });
}

export function useUpdateProjectBlueprint(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: BlueprintUpdateRequest }) =>
      api.updateProjectBlueprint(requireProjectId(projectId), id, body),
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "project", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "project", projectId, id],
      });
    },
  });
}

export function useDeleteProjectBlueprint(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProjectBlueprint(requireProjectId(projectId), id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "project", projectId],
      });
    },
  });
}

export function useDuplicateProjectBlueprint(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const pid = requireProjectId(projectId);
      const [blueprints, detail] = await Promise.all([
        api.fetchBlueprints(pid),
        api.fetchBlueprint(pid, id),
      ]);
      const name = deriveDuplicateName(
        detail.name,
        blueprints.map((b) => b.name),
      );

      return api.createProjectBlueprint(pid, {
        name,
        description: detail.description,
        icon: detail.icon,
        content: detail.content,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["blueprints", "project", projectId],
      });
    },
  });
}

export function useInjectBlueprint() {
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      blueprintId,
      sessionId,
    }: {
      projectId: string;
      benchId: number;
      blueprintId: string;
      sessionId?: string;
    }) => api.injectBlueprint(projectId, benchId, blueprintId, sessionId),
  });
}

export function useBlueprintPreview({
  content,
  projectId,
  benchId,
}: {
  content: string;
  projectId?: string;
  benchId?: number;
}) {
  // Initialise from content so the first render fires the query immediately
  // (no 300 ms delay when opening an existing blueprint). Subsequent edits
  // are debounced via the effect below.
  const [debouncedContent, setDebouncedContent] = useState(content);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedContent(content), 300);
    return () => clearTimeout(id);
  }, [content]);

  return useQuery({
    queryKey: ["blueprint-preview", debouncedContent, projectId ?? null, benchId ?? null],
    queryFn: () => api.previewBlueprint({ content: debouncedContent, projectId, benchId }),
    enabled: debouncedContent.trim().length > 0,
    staleTime: 30_000,
  });
}
