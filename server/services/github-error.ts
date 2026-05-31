import { ServiceError } from "./service-error.js";
import type { GitHubErrorCode } from "@roubo/shared";

export type { GitHubErrorCode };

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;
  readonly statusCode: number;
  readonly params: Record<string, string>;

  constructor(
    code: GitHubErrorCode,
    message: string,
    statusCode: number,
    params: Record<string, string> = {},
  ) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
    this.statusCode = statusCode;
    this.params = params;
  }
}

// Duck-type shape that matches Octokit RequestError and similar HTTP error objects.
interface HttpError {
  status: number;
  message?: string;
  response?: {
    headers: Record<string, string | string[] | undefined>;
  };
}

function isHttpError(err: unknown): err is HttpError {
  return (
    err !== null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

// Duck-type shape that matches Octokit GraphqlResponseError (errors array but no HTTP status).
interface GraphqlError {
  errors: Array<{ type?: string; message?: string }>;
  message?: string;
}

function isGraphqlError(err: unknown): err is GraphqlError {
  return (
    err !== null &&
    typeof err === "object" &&
    "errors" in err &&
    Array.isArray((err as { errors: unknown }).errors)
  );
}

// GitHub returns this 403 body when an org has enabled OAuth App access
// restrictions and the Roubo app has not been approved for that org. The text
// contains neither "forbidden" nor "saml"/"sso", so without this pattern it
// would fall through to UNKNOWN. Treated as ORG_APPROVAL_REQUIRED because the
// fix is the same: an org owner approves (or a member requests) the app.
const OAUTH_APP_RESTRICTION_RE =
  /oauth app access restrictions|restricting-access-to-your-organization/i;

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function specificity(code: GitHubErrorCode): number {
  // Higher index = lower specificity. Auth/permission errors beat operational/generic ones.
  const order: GitHubErrorCode[] = [
    "NOT_CONNECTED",
    "SAML_SSO_REQUIRED",
    "SCOPES_OUTDATED",
    "ORG_APPROVAL_REQUIRED",
    "OWNER_NOT_FOUND",
    "RATE_LIMITED",
    "NETWORK",
    "UNKNOWN",
  ];
  return order.length - order.indexOf(code);
}

function classifyOne(err: unknown, context?: { owner?: string }): GitHubError {
  if (err instanceof GitHubError) return err;

  const owner = context?.owner ?? "";
  const params: Record<string, string> = owner ? { owner } : {};

  // Our own not-connected ServiceError
  if (err instanceof ServiceError && err.statusCode === 401) {
    return new GitHubError("NOT_CONNECTED", err.message, 401);
  }

  // Octokit GraphQL response errors (HTTP 200 but errors[] in body)
  if (isGraphqlError(err)) {
    const firstType = err.errors[0]?.type ?? "";
    const msg = err.message ?? err.errors[0]?.message ?? "Unknown GraphQL error";

    if (/insufficient.scopes|required.scopes|read:project|read:org/i.test(msg)) {
      return new GitHubError("SCOPES_OUTDATED", msg, 403, params);
    }
    if (/saml|sso/i.test(msg)) {
      return new GitHubError("SAML_SSO_REQUIRED", msg, 403, params);
    }
    if (firstType === "FORBIDDEN" || /not accessible by integration|forbidden/i.test(msg)) {
      return new GitHubError("ORG_APPROVAL_REQUIRED", msg, 403, params);
    }
    if (firstType === "NOT_FOUND" || /could not resolve/i.test(msg)) {
      return new GitHubError("OWNER_NOT_FOUND", msg, 404, params);
    }
    return new GitHubError("UNKNOWN", msg, 500);
  }

  // HTTP-level errors (Octokit RequestError or similar)
  if (isHttpError(err)) {
    const { status } = err;
    const msg = err.message ?? "GitHub request failed";
    const headers = err.response?.headers ?? {};

    if (status === 401 || /bad credentials|not connected/i.test(msg)) {
      return new GitHubError("NOT_CONNECTED", msg, 401);
    }

    // SAML: GitHub returns x-github-sso header for SSO-required 403s
    const ssoHeader = getHeader(headers, "x-github-sso");
    if (ssoHeader || (status === 403 && /saml|sso/i.test(msg))) {
      return new GitHubError("SAML_SSO_REQUIRED", msg, 403, params);
    }

    if (status === 403) {
      if (/read:project|read:org|required scopes|insufficient.scopes/i.test(msg)) {
        return new GitHubError("SCOPES_OUTDATED", msg, 403, params);
      }
      const remaining = getHeader(headers, "x-ratelimit-remaining");
      const retryAfter = getHeader(headers, "retry-after");
      if (remaining === "0" || /secondary rate limit|abuse/i.test(msg)) {
        const retryAfterSec = retryAfter ?? "";
        return new GitHubError("RATE_LIMITED", msg, 429, retryAfterSec ? { retryAfterSec } : {});
      }
      if (
        /not accessible by integration|forbidden/i.test(msg) ||
        OAUTH_APP_RESTRICTION_RE.test(msg)
      ) {
        return new GitHubError("ORG_APPROVAL_REQUIRED", msg, 403, params);
      }
    }

    if (status === 429) {
      const retryAfter = getHeader(headers, "retry-after") ?? "";
      return new GitHubError(
        "RATE_LIMITED",
        msg,
        429,
        retryAfter ? { retryAfterSec: retryAfter } : {},
      );
    }

    if (status === 404 && /could not resolve|organization.*not found|user.*not found/i.test(msg)) {
      return new GitHubError("OWNER_NOT_FOUND", msg, 404, params);
    }
  }

  // Node network errors (no HTTP status)
  if (err !== null && typeof err === "object") {
    const nodeCode = (err as { code?: unknown }).code;
    if (typeof nodeCode === "string" && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/.test(nodeCode)) {
      return new GitHubError("NETWORK", (err as Error).message ?? "Network error", 503);
    }
    if (err instanceof TypeError && /fetch failed/i.test((err as Error).message ?? "")) {
      return new GitHubError("NETWORK", (err as Error).message, 503);
    }
  }

  const msg = err instanceof Error ? err.message : String(err);

  // Final fallback: match known GitHub error message patterns for plain Error objects.
  if (
    /resource not accessible by integration|forbidden/i.test(msg) ||
    OAUTH_APP_RESTRICTION_RE.test(msg)
  ) {
    return new GitHubError("ORG_APPROVAL_REQUIRED", msg, 403, params);
  }
  if (/saml|sso/i.test(msg)) {
    return new GitHubError("SAML_SSO_REQUIRED", msg, 403, params);
  }
  if (/bad credentials|not connected/i.test(msg)) {
    return new GitHubError("NOT_CONNECTED", msg, 401);
  }
  if (/read:project|read:org|required scopes|insufficient.scopes/i.test(msg)) {
    return new GitHubError("SCOPES_OUTDATED", msg, 403, params);
  }
  if (/could not resolve|organization.*not found|user.*not found/i.test(msg)) {
    return new GitHubError("OWNER_NOT_FOUND", msg, 404, params);
  }

  return new GitHubError("UNKNOWN", msg, 500);
}

/**
 * Classifies a GitHub-related error into a canonical GitHubError with a stable code.
 */
export function classifyGitHubError(err: unknown, context?: { owner?: string }): GitHubError {
  return classifyOne(err, context);
}

/**
 * Classifies two errors (e.g. org-query failure + user-query failure) and returns
 * the more specific classification of the two.
 */
export function classifyGitHubErrors(
  err: unknown,
  err2: unknown,
  context?: { owner?: string },
): GitHubError {
  const primary = classifyOne(err, context);
  const secondary = classifyOne(err2, context);
  return specificity(primary.code) >= specificity(secondary.code) ? primary : secondary;
}
