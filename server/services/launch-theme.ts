import type { ResolvedTheme, ThemeMode } from "@roubo/shared";

/**
 * The app theme a PTY session is spawned under (#1383).
 *
 * The client's resolved theme wins, because only the client knows what
 * `system` resolved to. A launch with no client theme (a server-driven agent
 * start such as issue assignment, or an older client) falls back to the stored
 * preference when that is explicit. `system` with no client theme gives no
 * theme at all: the server cannot see the OS scheme the window follows, and no
 * hint is better than a wrong one.
 *
 * `requested` is the raw request body value, so anything other than the two
 * theme names is dropped rather than passed on to a child environment.
 */
export function resolveLaunchTheme(
  requested: unknown,
  stored: ThemeMode | undefined,
): ResolvedTheme | undefined {
  if (requested === "light" || requested === "dark") return requested;
  if (stored === "light" || stored === "dark") return stored;
  return undefined;
}

/**
 * The terminal background hint for a child environment: `COLORFGBG` in the
 * rxvt `fg;bg` form, where a background of 15 (white) reads as light and 0
 * (black) as dark. Programs that pick a palette from it then match the theme
 * without an agent-specific hint. Empty when the theme is unknown, so any value
 * the server inherited is left as it was.
 *
 * It is a snapshot taken at spawn: a later theme change does not reach a
 * running program.
 */
export function themeEnvHint(theme: ResolvedTheme | undefined): Record<string, string> {
  if (theme === undefined) return {};
  return { COLORFGBG: theme === "light" ? "0;15" : "15;0" };
}
