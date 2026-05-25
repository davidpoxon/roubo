import crypto from "node:crypto";

// Token-scope detector and in-process cache for the bundled github-com plugin.
// Lives here for WU-028; WU-029 migrates it into plugins/_shared-github/.
// Invariant: the raw bearer token NEVER appears in cache keys, values, or any
// stringification path. The only token-derived value that may leave this module
// is the SHA-256 fingerprint.

export const SCOPE_CACHE_TTL_MS = 5 * 60 * 1000;

export type ScopeProbeResult = { kind: "granted" } | { kind: "lacking" } | { kind: "unknown" };

interface ScopeCacheEntry {
  scopes: string[] | null;
  capturedAt: number;
}

const scopeCache = new Map<string, ScopeCacheEntry>();

export function fingerprintToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function parseScopesFromResponse(
  response: { headers: Headers } | Response,
): string[] | null {
  const raw = response.headers.get("X-OAuth-Scopes");
  if (raw === null) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function detectScope(scopes: string[] | null, probedScope: string): ScopeProbeResult {
  if (scopes === null) return { kind: "unknown" };
  return scopes.includes(probedScope) ? { kind: "granted" } : { kind: "lacking" };
}

export function probeTokenScope(
  token: string,
  response: { headers: Headers },
  probedScope: string,
  now: () => number = Date.now,
): ScopeProbeResult {
  const fingerprint = fingerprintToken(token);
  const cached = scopeCache.get(fingerprint);
  const currentTime = now();
  if (cached !== undefined && currentTime - cached.capturedAt < SCOPE_CACHE_TTL_MS) {
    return detectScope(cached.scopes, probedScope);
  }
  const scopes = parseScopesFromResponse(response);
  scopeCache.set(fingerprint, { scopes, capturedAt: currentTime });
  return detectScope(scopes, probedScope);
}

export function invalidateTokenScopeCache(token: string): void {
  scopeCache.delete(fingerprintToken(token));
}

export const __test = {
  reset(): void {
    scopeCache.clear();
  },
  size(): number {
    return scopeCache.size;
  },
  rawKeys(): string[] {
    return Array.from(scopeCache.keys());
  },
};
