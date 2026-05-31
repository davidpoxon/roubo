/**
 * Host-side record of the instance host each integration plugin is currently
 * configured against. Self-hosted plugins (Jira, GHE) declare a `**` network
 * allowlist because their host is user-supplied and unknown at manifest time,
 * so the manifest alone cannot constrain `host.fetch`. This registry lets the
 * host narrow `**` down to the one host the user configured as the instance.
 *
 * It lives in its own module to keep the writer (`plugin-activation.ts`, which
 * derives the effective instance before every source-bound RPC) and the readers
 * (`plugin-host-api.ts` / `plugin-http.ts`, which enforce the constraint at
 * fetch time) free of a circular import. See issue #338.
 */

// pluginId -> lowercased instance host (incl. port) or null when no instance is
// configured (e.g. github.com, which has a fixed API host and no instance knob).
const instanceHosts = new Map<string, string | null>();

/**
 * Parse a configured instance URL into the host (host + port, lowercased) the
 * plugin's `host.fetch` calls must stay on, mirroring the plugin-side guard in
 * `jira-client.ts buildUrl`. Returns null for an empty, non-string, or
 * unparseable instance so callers treat it as "no constraint".
 */
export function deriveInstanceHost(instance: unknown): string | null {
  if (typeof instance !== "string" || instance.length === 0) return null;
  try {
    return new URL(instance).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Record (or clear, with `null`) the instance host a plugin is constrained to. */
export function setInstanceHost(pluginId: string, host: string | null): void {
  instanceHosts.set(pluginId, host);
}

/**
 * Return the instance host a plugin's `host.fetch` is constrained to, or null
 * when no instance is configured (or the plugin has never been activated), in
 * which case the manifest allowlist governs alone.
 */
export function getInstanceHost(pluginId: string): string | null {
  return instanceHosts.get(pluginId) ?? null;
}

/** Drop all recorded instance hosts. Used by tests; mirrors clearActivationCache. */
export function clearInstanceRegistry(): void {
  instanceHosts.clear();
}
