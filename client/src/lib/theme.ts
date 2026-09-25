import type { ResolvedTheme } from "@roubo/shared";

/**
 * The theme the app is showing right now, read from the `dark` class that
 * `applyTheme` (hooks/useSettings.ts) keeps on `<html>`. The class is already
 * resolved, so `system` has become the OS scheme by the time this reads it.
 */
export function resolvedTheme(): ResolvedTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
