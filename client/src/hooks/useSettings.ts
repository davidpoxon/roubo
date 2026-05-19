import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import * as api from "../lib/api";
import type { ThemeMode, UserPreferences, SettingsResponse } from "@roubo/shared";

// Keep in sync with the FOUC-prevention script in client/index.html
const THEME_STORAGE_KEY = "roubo-theme";

function applyTheme(theme: ThemeMode) {
  const isDark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
  if (localStorage.getItem(THEME_STORAGE_KEY) !== theme) {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }
  window.roubo?.setTitleBarOverlayTheme(isDark ? "dark" : "light");
}

// Called once at the app root to keep the theme class and matchMedia listener in sync.
export function useThemeSync() {
  const query = useQuery({
    queryKey: ["settings"],
    queryFn: api.fetchSettings,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!query.data) return;
    applyTheme(query.data.theme);
  }, [query.data]);

  useEffect(() => {
    if (query.data?.theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query.data?.theme]);
}

export function useSettings() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["settings"],
    queryFn: api.fetchSettings,
    staleTime: Infinity,
  });

  const mutation = useMutation({
    mutationFn: (settings: UserPreferences) => api.updateSettings(settings),
    onMutate: async (newSettings) => {
      applyTheme(newSettings.theme);
      await queryClient.cancelQueries({ queryKey: ["settings"] });
      const previous = queryClient.getQueryData<SettingsResponse>(["settings"]);
      queryClient.setQueryData(["settings"], { ...previous, ...newSettings });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["settings"], context.previous);
        applyTheme(context.previous.theme);
      }
    },
  });

  return {
    settings: query.data,
    isLoading: query.isLoading,
    updateSettings: mutation.mutate,
  };
}

export function useRecheckClaudeCode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.recheckClaudeCode,
    onSuccess: (data) => {
      queryClient.setQueryData<SettingsResponse>(["settings"], (old) =>
        old ? { ...old, claudeCodeAutoModeReason: undefined, ...data } : old,
      );
    },
  });
}
