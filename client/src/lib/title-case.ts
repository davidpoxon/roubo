/**
 * Render an arbitrary identifier as a title-cased English label.
 *   "repos"        → "Repos"
 *   "issueTypes"   → "Issue Types"
 *   "allow_self_tls" → "Allow Self Tls"
 *
 * Used for plugin-defined source category keys and configSchema field keys
 * that lack an explicit `title`.
 */
export function titleCase(key: string): string {
  const spaced = key.replace(/([A-Z])/g, " $1").replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
