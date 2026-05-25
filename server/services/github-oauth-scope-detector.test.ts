import { describe, it, expect, beforeEach } from "vitest";
import {
  SCOPE_CACHE_TTL_MS,
  __test,
  detectScope,
  fingerprintToken,
  invalidateTokenScopeCache,
  parseScopesFromResponse,
  probeTokenScope,
} from "./github-oauth-scope-detector.js";

function responseWithScopes(scopes: string | null): { headers: Headers } {
  const headers = new Headers();
  if (scopes !== null) headers.set("X-OAuth-Scopes", scopes);
  return { headers };
}

beforeEach(() => {
  __test.reset();
});

describe("parseScopesFromResponse", () => {
  it("returns the trimmed scope list for a populated header", () => {
    expect(parseScopesFromResponse(responseWithScopes("repo, read:org"))).toEqual([
      "repo",
      "read:org",
    ]);
  });

  it("returns null when the header is absent", () => {
    expect(parseScopesFromResponse(responseWithScopes(null))).toBeNull();
  });

  it("returns an empty list when the header is present but empty", () => {
    expect(parseScopesFromResponse(responseWithScopes(""))).toEqual([]);
  });
});

describe("detectScope", () => {
  it("returns granted when the probed scope is present", () => {
    expect(detectScope(["repo", "security_events", "read:org"], "security_events")).toEqual({
      kind: "granted",
    });
  });

  it("returns lacking when the probed scope is absent from a known list", () => {
    expect(detectScope(["repo", "read:org"], "security_events")).toEqual({ kind: "lacking" });
  });

  it("returns unknown when the scope list is null", () => {
    expect(detectScope(null, "security_events")).toEqual({ kind: "unknown" });
  });
});

describe("fingerprintToken", () => {
  it("returns a 64-character lowercase hex SHA-256 digest", () => {
    const fp = fingerprintToken("ghp_secret_token");
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    expect(fingerprintToken("ghp_x")).toBe(fingerprintToken("ghp_x"));
  });

  it("differs for different inputs", () => {
    expect(fingerprintToken("a")).not.toBe(fingerprintToken("b"));
  });
});

describe("probeTokenScope", () => {
  it("returns granted when the header carries the probed scope", () => {
    const result = probeTokenScope(
      "ghp_a",
      responseWithScopes("repo, security_events, read:org"),
      "security_events",
    );
    expect(result).toEqual({ kind: "granted" });
  });

  it("returns lacking when the header omits the probed scope", () => {
    const result = probeTokenScope(
      "ghp_a",
      responseWithScopes("repo, read:org"),
      "security_events",
    );
    expect(result).toEqual({ kind: "lacking" });
  });

  it("returns unknown when X-OAuth-Scopes is absent", () => {
    const result = probeTokenScope("ghp_a", responseWithScopes(null), "security_events");
    expect(result).toEqual({ kind: "unknown" });
  });

  it("reuses cached scopes within the TTL even if a later response lacks the header", () => {
    const t0 = 1_000_000;
    const seed = probeTokenScope(
      "ghp_a",
      responseWithScopes("repo, security_events"),
      "security_events",
      () => t0,
    );
    expect(seed).toEqual({ kind: "granted" });

    const cached = probeTokenScope(
      "ghp_a",
      responseWithScopes(null),
      "security_events",
      () => t0 + SCOPE_CACHE_TTL_MS - 1,
    );
    expect(cached).toEqual({ kind: "granted" });
  });

  it("re-evaluates after the TTL expires", () => {
    const t0 = 1_000_000;
    probeTokenScope("ghp_a", responseWithScopes("repo"), "security_events", () => t0);
    const refreshed = probeTokenScope(
      "ghp_a",
      responseWithScopes("repo, security_events"),
      "security_events",
      () => t0 + SCOPE_CACHE_TTL_MS,
    );
    expect(refreshed).toEqual({ kind: "granted" });
  });

  it("caches per token, so different tokens do not collide", () => {
    probeTokenScope("ghp_a", responseWithScopes("repo, security_events"), "security_events");
    const b = probeTokenScope("ghp_b", responseWithScopes("repo"), "security_events");
    expect(b).toEqual({ kind: "lacking" });
  });
});

describe("invalidateTokenScopeCache", () => {
  it("removes only the targeted token's cache entry", () => {
    probeTokenScope("ghp_a", responseWithScopes("repo, security_events"), "security_events");
    probeTokenScope("ghp_b", responseWithScopes("repo"), "security_events");
    expect(__test.size()).toBe(2);

    invalidateTokenScopeCache("ghp_a");
    expect(__test.size()).toBe(1);

    const bStill = probeTokenScope("ghp_b", responseWithScopes(null), "security_events");
    expect(bStill).toEqual({ kind: "lacking" });
  });

  it("is a no-op for a token that was never cached", () => {
    expect(() => invalidateTokenScopeCache("never-seen")).not.toThrow();
    expect(__test.size()).toBe(0);
  });
});

describe("cache key opacity", () => {
  it("uses the fingerprint, never the raw token, as the cache key", () => {
    const token = "ghp_super_secret_value_123";
    probeTokenScope(token, responseWithScopes("repo"), "security_events");
    const keys = __test.rawKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(fingerprintToken(token));
    expect(keys[0]).not.toContain(token);
  });
});
