import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import { ApiError } from "../lib/api";
import { useToast } from "./useToast";

const PLUGINS_KEY = ["plugins"] as const;
const PLUGIN_REFETCH_MS = 5000;
const CONNECTION_STATUS_KEY_PREFIX = "plugin-connection-status";

export function connectionStatusQueryKey(pluginId: string): readonly [string, string] {
  return [CONNECTION_STATUS_KEY_PREFIX, pluginId];
}

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

export function useUninstallPlugin() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  return useMutation({
    mutationFn: (pluginId: string) => api.uninstallPlugin(pluginId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PLUGINS_KEY });
    },
    onError: (err) => {
      addToast(asErrorMessage(err, "Failed to uninstall plugin."));
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

// WU-050: read the cached connection-status for a plugin. Renders the cached
// value synchronously and never fires its own background poll: re-fetches
// only when an opportunistic trigger (PluginsTab / Configure modal / cut list
// mount) invalidates or prefetches the query.
export function useConnectionStatus(pluginId: string, enabled: boolean) {
  return useQuery({
    queryKey: connectionStatusQueryKey(pluginId),
    queryFn: () => api.fetchConnectionStatus(pluginId),
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

// WU-050: opportunistic re-check. On mount (and whenever the set of enabled
// plugin ids changes) fire a single `getConnectionStatus` RPC per enabled
// plugin. Disabled plugins are skipped. No setInterval/setTimeout. Per-plugin
// in-flight dedup is enforced by the plugin-manager singleton (WU-044), so
// near-simultaneous triggers (e.g. tab + cut list) coalesce server-side.
export function useOpportunisticRecheckOnMount(enabledIds: readonly string[]): void {
  const queryClient = useQueryClient();
  // Depend on the joined id list so re-renders that hand us a fresh array
  // reference with the same contents don't re-fire the RPC. Callers should
  // pass a memoized array, but this guard keeps us safe either way.
  const idsKey = enabledIds.join(",");
  useEffect(() => {
    if (!idsKey) return;
    for (const id of idsKey.split(",")) {
      void queryClient.fetchQuery({
        queryKey: connectionStatusQueryKey(id),
        queryFn: () => api.fetchConnectionStatus(id),
        staleTime: 0,
      });
    }
  }, [idsKey, queryClient]);
}
