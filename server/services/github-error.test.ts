import { describe, it, expect } from "vitest";
import { GitHubError, classifyGitHubError, classifyGitHubErrors } from "./github-error.js";
import { ServiceError } from "./service-error.js";

function makeHttpError(status: number, message: string, headers: Record<string, string> = {}) {
  return Object.assign(new Error(message), { status, response: { headers } });
}

function makeGraphqlError(type: string, message: string) {
  return Object.assign(new Error(message), { errors: [{ type, message }] });
}

describe("classifyGitHubError", () => {
  it("passthrough: already a GitHubError", () => {
    const e = new GitHubError("NOT_CONNECTED", "already", 401);
    expect(classifyGitHubError(e)).toBe(e);
  });

  it("rule 1: ServiceError(401) → NOT_CONNECTED", () => {
    const e = new ServiceError(
      401,
      "GitHub is not connected. Connect your GitHub account in Settings.",
    );
    const r = classifyGitHubError(e);
    expect(r.code).toBe("NOT_CONNECTED");
    expect(r.statusCode).toBe(401);
  });

  it("rule 2: HTTP 401 → NOT_CONNECTED", () => {
    const r = classifyGitHubError(makeHttpError(401, "Bad credentials"));
    expect(r.code).toBe("NOT_CONNECTED");
    expect(r.statusCode).toBe(401);
  });

  it("rule 3: HTTP 403 + x-github-sso header → SAML_SSO_REQUIRED with owner param", () => {
    const r = classifyGitHubError(
      makeHttpError(403, "SSO required", { "x-github-sso": "required; url=..." }),
      { owner: "my-org" },
    );
    expect(r.code).toBe("SAML_SSO_REQUIRED");
    expect(r.params.owner).toBe("my-org");
    expect(r.statusCode).toBe(403);
  });

  it("rule 3: HTTP 403 + saml in message → SAML_SSO_REQUIRED", () => {
    const r = classifyGitHubError(makeHttpError(403, "Resource protected by SAML enforcement"));
    expect(r.code).toBe("SAML_SSO_REQUIRED");
  });

  it("rule 4: HTTP 403 + scope message → SCOPES_OUTDATED", () => {
    const r = classifyGitHubError(makeHttpError(403, "Token requires read:project scope"), {
      owner: "acme",
    });
    expect(r.code).toBe("SCOPES_OUTDATED");
    expect(r.statusCode).toBe(403);
  });

  it("rule 5: HTTP 403 + not accessible → ORG_APPROVAL_REQUIRED with owner param", () => {
    const r = classifyGitHubError(makeHttpError(403, "Resource not accessible by integration"), {
      owner: "acme",
    });
    expect(r.code).toBe("ORG_APPROVAL_REQUIRED");
    expect(r.params.owner).toBe("acme");
  });

  it("rule 5: HTTP 403 + OAuth App access restrictions → ORG_APPROVAL_REQUIRED with owner param", () => {
    const r = classifyGitHubError(
      makeHttpError(
        403,
        "Although you appear to have the correct authorization credentials, the `int3nt` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.",
      ),
      { owner: "int3nt" },
    );
    expect(r.code).toBe("ORG_APPROVAL_REQUIRED");
    expect(r.params.owner).toBe("int3nt");
    expect(r.statusCode).toBe(403);
  });

  it("fallback: plain Error with OAuth App access restrictions message → ORG_APPROVAL_REQUIRED", () => {
    const r = classifyGitHubError(
      new Error("the `acme` organization has enabled OAuth App access restrictions"),
      { owner: "acme" },
    );
    expect(r.code).toBe("ORG_APPROVAL_REQUIRED");
    expect(r.params.owner).toBe("acme");
  });

  it("rule 6: HTTP 429 → RATE_LIMITED with retryAfterSec param", () => {
    const r = classifyGitHubError(
      makeHttpError(429, "rate limit exceeded", { "retry-after": "60" }),
    );
    expect(r.code).toBe("RATE_LIMITED");
    expect(r.statusCode).toBe(429);
    expect(r.params.retryAfterSec).toBe("60");
  });

  it("rule 6: HTTP 403 + x-ratelimit-remaining=0 → RATE_LIMITED", () => {
    const r = classifyGitHubError(
      makeHttpError(403, "rate limit", { "x-ratelimit-remaining": "0" }),
    );
    expect(r.code).toBe("RATE_LIMITED");
  });

  it("rule 7: HTTP 404 + not found message → OWNER_NOT_FOUND with owner param", () => {
    const r = classifyGitHubError(
      makeHttpError(404, 'Could not resolve to an Organization with the login of "acme"'),
      { owner: "acme" },
    );
    expect(r.code).toBe("OWNER_NOT_FOUND");
    expect(r.params.owner).toBe("acme");
    expect(r.statusCode).toBe(404);
  });

  it("rule 8: node ENOTFOUND → NETWORK", () => {
    const e = Object.assign(new Error("getaddrinfo ENOTFOUND api.github.com"), {
      code: "ENOTFOUND",
    });
    const r = classifyGitHubError(e);
    expect(r.code).toBe("NETWORK");
    expect(r.statusCode).toBe(503);
  });

  it("rule 8: fetch failed TypeError → NETWORK", () => {
    const r = classifyGitHubError(new TypeError("fetch failed"));
    expect(r.code).toBe("NETWORK");
  });

  it("rule 9 fallback: unknown error → UNKNOWN", () => {
    const r = classifyGitHubError(new Error("something unexpected"));
    expect(r.code).toBe("UNKNOWN");
    expect(r.statusCode).toBe(500);
  });

  it("GraphQL FORBIDDEN type → ORG_APPROVAL_REQUIRED", () => {
    const r = classifyGitHubError(
      makeGraphqlError("FORBIDDEN", "Resource not accessible by integration"),
      { owner: "o" },
    );
    expect(r.code).toBe("ORG_APPROVAL_REQUIRED");
  });

  it("GraphQL NOT_FOUND type → OWNER_NOT_FOUND", () => {
    const r = classifyGitHubError(makeGraphqlError("NOT_FOUND", "Could not resolve to user"), {
      owner: "o",
    });
    expect(r.code).toBe("OWNER_NOT_FOUND");
  });

  it("GraphQL scope message → SCOPES_OUTDATED", () => {
    const r = classifyGitHubError(
      makeGraphqlError("", "Your token has not been granted the required scopes: read:project"),
    );
    expect(r.code).toBe("SCOPES_OUTDATED");
  });

  it("two errors: picks most specific classification", () => {
    const vague = makeHttpError(500, "Internal error");
    const specific = makeHttpError(401, "Bad credentials");
    const r = classifyGitHubErrors(vague, specific, { owner: "o" });
    expect(r.code).toBe("NOT_CONNECTED");
  });

  it("two errors: both UNKNOWN → returns UNKNOWN", () => {
    const r = classifyGitHubErrors(new Error("a"), new Error("b"));
    expect(r.code).toBe("UNKNOWN");
  });

  it("two errors: same specific code on both → returns that code", () => {
    const a = makeHttpError(401, "Bad credentials");
    const b = makeHttpError(401, "Bad credentials again");
    const r = classifyGitHubErrors(a, b);
    expect(r.code).toBe("NOT_CONNECTED");
  });

  it("two errors: first more specific than second → returns first", () => {
    const moreSpecific = makeHttpError(401, "Bad credentials");
    const lessSpecific = makeHttpError(503, "Service unavailable");
    const r = classifyGitHubErrors(moreSpecific, lessSpecific);
    expect(r.code).toBe("NOT_CONNECTED");
  });

  it("owner param is threaded when context is provided", () => {
    const r = classifyGitHubError(makeHttpError(403, "Resource not accessible by integration"), {
      owner: "my-company",
    });
    expect(r.params.owner).toBe("my-company");
  });

  it("no owner param when context is absent", () => {
    const r = classifyGitHubError(makeHttpError(403, "Resource not accessible by integration"));
    expect(r.params.owner).toBeUndefined();
  });
});
