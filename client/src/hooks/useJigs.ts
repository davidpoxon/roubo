import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { GLOBAL_DEFAULT_JIG_ID } from "@roubo/shared";
import type { JigCreateRequest, JigUpdateRequest } from "@roubo/shared";
import * as api from "../lib/api";
import { deriveDuplicateName } from "../lib/duplicateJigName";

function requireProjectId(projectId: string | undefined): string {
  if (!projectId) {
    throw new Error("projectId is required");
  }
  return projectId;
}

export function useGlobalJigs() {
  return useQuery({
    queryKey: ["jigs", "global"],
    queryFn: () => api.fetchGlobalJigs(),
    staleTime: 60_000,
  });
}

export function useJigs(projectId: string | undefined) {
  return useQuery({
    queryKey: ["jigs", "project", projectId],
    queryFn: () => api.fetchJigs(projectId as string),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useGlobalJig(jigId: string | undefined) {
  return useQuery({
    queryKey: ["jigs", "global", jigId],
    queryFn: () => api.fetchGlobalJig(jigId as string),
    enabled: !!jigId && jigId !== GLOBAL_DEFAULT_JIG_ID,
    staleTime: 30_000,
  });
}

export function useProjectJig(projectId: string | undefined, jigId: string | undefined) {
  return useQuery({
    queryKey: ["jigs", "project", projectId, jigId],
    queryFn: () => api.fetchJig(projectId as string, jigId as string),
    enabled: !!projectId && !!jigId && jigId !== GLOBAL_DEFAULT_JIG_ID,
    staleTime: 30_000,
  });
}

export function useCreateGlobalJig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: JigCreateRequest) => api.createGlobalJig(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "global"],
      });
    },
  });
}

export function useUpdateGlobalJig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: JigUpdateRequest }) =>
      api.updateGlobalJig(id, body),
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "global"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "global", id],
      });
    },
  });
}

export function useDeleteGlobalJig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteGlobalJig(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "global"],
      });
    },
  });
}

export function useDuplicateGlobalJig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const [jigs, detail] = await Promise.all([api.fetchGlobalJigs(), api.fetchGlobalJig(id)]);
      const name = deriveDuplicateName(
        detail.name,
        jigs.map((b) => b.name),
      );

      return api.createGlobalJig({
        name,
        description: detail.description,
        icon: detail.icon,
        content: detail.content,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "global"],
      });
    },
  });
}

export function useCreateProjectJig(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: JigCreateRequest) => api.createProjectJig(requireProjectId(projectId), body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "project", projectId],
      });
    },
  });
}

export function useUpdateProjectJig(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: JigUpdateRequest }) =>
      api.updateProjectJig(requireProjectId(projectId), id, body),
    onSuccess: (_, { id }) => {
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "project", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "project", projectId, id],
      });
    },
  });
}

export function useDeleteProjectJig(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProjectJig(requireProjectId(projectId), id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "project", projectId],
      });
    },
  });
}

export function useDuplicateProjectJig(projectId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const pid = requireProjectId(projectId);
      const [jigs, detail] = await Promise.all([api.fetchJigs(pid), api.fetchJig(pid, id)]);
      const name = deriveDuplicateName(
        detail.name,
        jigs.map((b) => b.name),
      );

      return api.createProjectJig(pid, {
        name,
        description: detail.description,
        icon: detail.icon,
        content: detail.content,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["jigs", "project", projectId],
      });
    },
  });
}

export function useInjectJig() {
  return useMutation({
    mutationFn: ({
      projectId,
      benchId,
      jigId,
      sessionId,
    }: {
      projectId: string;
      benchId: number;
      jigId: string;
      sessionId?: string;
    }) => api.injectJig(projectId, benchId, jigId, sessionId),
  });
}

export function useJigPreview({
  content,
  projectId,
  benchId,
}: {
  content: string;
  projectId?: string;
  benchId?: number;
}) {
  // Initialise from content so the first render fires the query immediately
  // (no 300 ms delay when opening an existing jig). Subsequent edits
  // are debounced via the effect below.
  const [debouncedContent, setDebouncedContent] = useState(content);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedContent(content), 300);
    return () => clearTimeout(id);
  }, [content]);

  return useQuery({
    queryKey: ["jig-preview", debouncedContent, projectId ?? null, benchId ?? null],
    queryFn: () => api.previewJig({ content: debouncedContent, projectId, benchId }),
    enabled: debouncedContent.trim().length > 0,
    staleTime: 30_000,
  });
}
