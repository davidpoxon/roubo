import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import { ApiError } from "../lib/api";
import { useToast } from "./useToast";

const PLUGINS_KEY = ["plugins"] as const;
const PLUGIN_REFETCH_MS = 5000;

export function usePlugins() {
  return useQuery({
    queryKey: PLUGINS_KEY,
    queryFn: api.fetchPlugins,
    refetchInterval: PLUGIN_REFETCH_MS,
    refetchOnWindowFocus: true,
  });
}

function asErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function useEnablePlugin() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  return useMutation({
    mutationFn: (pluginId: string) => api.enablePlugin(pluginId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PLUGINS_KEY });
    },
    onError: (err) => {
      addToast(asErrorMessage(err, "Failed to enable plugin."));
    },
  });
}

export function useDisablePlugin() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  return useMutation({
    mutationFn: (pluginId: string) => api.disablePlugin(pluginId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PLUGINS_KEY });
    },
    onError: (err) => {
      addToast(asErrorMessage(err, "Failed to disable plugin."));
    },
  });
}

export function useRestartPlugin() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  return useMutation({
    mutationFn: (pluginId: string) => api.restartPlugin(pluginId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PLUGINS_KEY });
    },
    onError: (err) => {
      addToast(asErrorMessage(err, "Failed to restart plugin."));
    },
  });
}

export function usePluginLogs(pluginId: string, file: "current" | "previous", enabled: boolean) {
  return useQuery({
    queryKey: ["plugin-logs", pluginId, file],
    queryFn: () => api.fetchPluginLogs(pluginId, file),
    enabled,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}

// WU-011: two-stage install. Errors are surfaced inline by the dialog (no
// global toast), so we deliberately omit onError handlers on preview/cancel.
export function useInstallPluginPreview() {
  return useMutation({
    mutationFn: (body: { source: "git" | "local"; value: string }) =>
      api.previewInstallPlugin(body),
  });
}

export function useInstallPluginConfirm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stagingToken: string) => api.confirmInstallPlugin(stagingToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PLUGINS_KEY });
    },
  });
}

export function useInstallPluginCancel() {
  return useMutation({
    mutationFn: (stagingToken: string) => api.cancelInstallPlugin(stagingToken),
  });
}
