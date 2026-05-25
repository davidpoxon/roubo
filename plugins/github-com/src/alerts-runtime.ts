/**
 * Per-repo dispatcher for the three Code/Secret/Dependabot alert categories.
 *
 * Wraps the `_shared-github` fetchers with `safeFetchAlerts` so per-category
 * fetch failures degrade to a `ListIssuesWarning` rather than throwing the
 * whole `listIssues` call. Only invoked on page 1 of a `listIssues` call;
 * `paginateAlerts` walks all alert pages internally, so subsequent issue
 * pages MUST NOT re-fetch.
 */

import type { FetchInit, FetchResult, ListIssuesWarning, NormalizedIssue } from "@roubo/plugin-sdk";
import {
  detectTokenScopes,
  fetchCodeScanningAlerts,
  fetchDependabotAlerts,
  fetchSecretScanningAlerts,
  mapCodeScanningAlertToNormalizedIssue,
  mapDependabotAlertToNormalizedIssue,
  mapSecretScanningAlertToNormalizedIssue,
  safeFetchAlerts,
  type FetchTransport,
} from "@roubo/shared-github";
import { getHost } from "./host-binding.js";
import { INTEGRATION_ID } from "./normalize.js";

const GITHUB_API_BASE = "https://api.github.com";

/**
 * NFR-015 graceful copy for fine-grained PATs / GitHub App installation
 * tokens that do not emit the `X-OAuth-Scopes` response header. The
 * client renders this verbatim as the chip tooltip. Do not edit casually.
 */
export const SCOPE_UNVERIFIABLE_CAUSE =
  "Unable to verify token scopes. If category data is missing, regenerate your token with the security alert permission.";

export interface AlertFlags {
  includeCodeQLAlerts?: boolean;
  includeSecretScanningAlerts?: boolean;
  includeDependabotAlerts?: boolean;
}

export interface FetchRepoAlertsResult {
  items: NormalizedIssue[];
  /**
   * Warnings emitted by this dispatch. `sourceExternalId` is left for the
   * caller to fill: it is the configured-source id (e.g. the project source
   * `owner/#42`), which a project that spans multiple repos shares across
   * its per-repo dispatches.
   */
  warnings: Array<Omit<ListIssuesWarning, "sourceExternalId">>;
}

let cachedToken: string | null = null;
let cachedScopeProbe: Promise<"known" | "unknown"> | null = null;

async function getTransport(): Promise<FetchTransport> {
  const host = getHost();
  if (!cachedToken) {
    cachedToken = await host.credentials.get("github-token");
  }
  const token = cachedToken;
  return async (url: string, init?: FetchInit): Promise<FetchResult> => {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    if (token && !headers.Authorization && !headers.authorization) {
      headers.Authorization = `Bearer ${token}`;
    }
    return host.fetch(url, { ...init, headers });
  };
}

/**
 * One-shot probe of `/user` to detect whether the current token emits
 * `X-OAuth-Scopes`. Cached per process; cleared by `resetAlertsRuntime()`.
 * Returns `"unknown"` for fine-grained PATs / GitHub App tokens (NFR-015)
 * so callers can rewrite a `missing-scope` warning to `scope-unverifiable`.
 */
async function probeTokenShape(transport: FetchTransport): Promise<"known" | "unknown"> {
  if (!cachedScopeProbe) {
    cachedScopeProbe = (async () => {
      const result = await detectTokenScopes(transport, GITHUB_API_BASE);
      return result.kind === "unknown" ? "unknown" : "known";
    })();
  }
  return cachedScopeProbe;
}

/** Reset the cached GitHub token and scope-probe result. Tests call this between cases. */
export function resetAlertsRuntime(): void {
  cachedToken = null;
  cachedScopeProbe = null;
}

function parseOwnerRepo(repoFullName: string): { owner: string; repo: string } | null {
  const slash = repoFullName.indexOf("/");
  if (slash <= 0 || slash === repoFullName.length - 1) return null;
  return { owner: repoFullName.slice(0, slash), repo: repoFullName.slice(slash + 1) };
}

/**
 * Fetch every category enabled in `flags` for a single repo. The three
 * fetchers run in parallel; a per-category failure becomes a warning and
 * does not affect the others (AC #8). Returns mapped NormalizedIssues
 * concatenated in fixed order: code-scanning, secret-scanning, dependabot.
 */
export async function fetchRepoAlerts(
  repoFullName: string,
  flags: AlertFlags,
): Promise<FetchRepoAlertsResult> {
  const enabled =
    flags.includeCodeQLAlerts === true ||
    flags.includeSecretScanningAlerts === true ||
    flags.includeDependabotAlerts === true;
  if (!enabled) {
    return { items: [], warnings: [] };
  }

  const parsed = parseOwnerRepo(repoFullName);
  if (!parsed) {
    return { items: [], warnings: [] };
  }
  const { owner, repo } = parsed;

  const transport = await getTransport();
  const fetchArgs = { baseUrl: GITHUB_API_BASE, owner, repo };

  const [codeRes, secretRes, depRes] = await Promise.all([
    flags.includeCodeQLAlerts === true
      ? safeFetchAlerts("code-scanning", () => fetchCodeScanningAlerts(transport, fetchArgs))
      : Promise.resolve(null),
    flags.includeSecretScanningAlerts === true
      ? safeFetchAlerts("secret-scanning", () => fetchSecretScanningAlerts(transport, fetchArgs))
      : Promise.resolve(null),
    flags.includeDependabotAlerts === true
      ? safeFetchAlerts("dependabot", () => fetchDependabotAlerts(transport, fetchArgs))
      : Promise.resolve(null),
  ]);

  const items: NormalizedIssue[] = [];
  const warnings: FetchRepoAlertsResult["warnings"] = [];

  const pushWarning = (
    category: "code-scanning" | "secret-scanning" | "dependabot",
    res: { cause: string; status?: number; code: string; missingScope?: string },
  ): void => {
    const detail: NonNullable<ListIssuesWarning["detail"]> = {};
    if (res.status !== undefined) detail.status = res.status;
    if (res.missingScope !== undefined) detail.missingScope = res.missingScope;
    warnings.push({
      category,
      cause: res.cause,
      code: res.code as FetchRepoAlertsResult["warnings"][number]["code"],
      ...(Object.keys(detail).length > 0 ? { detail } : {}),
    });
  };

  if (codeRes) {
    if (codeRes.ok) {
      for (const raw of codeRes.items) {
        items.push(mapCodeScanningAlertToNormalizedIssue(INTEGRATION_ID, repoFullName, raw));
      }
    } else {
      pushWarning("code-scanning", codeRes);
    }
  }
  if (secretRes) {
    if (secretRes.ok) {
      for (const raw of secretRes.items) {
        items.push(mapSecretScanningAlertToNormalizedIssue(INTEGRATION_ID, repoFullName, raw));
      }
    } else {
      pushWarning("secret-scanning", secretRes);
    }
  }
  if (depRes) {
    if (depRes.ok) {
      for (const raw of depRes.items) {
        items.push(mapDependabotAlertToNormalizedIssue(INTEGRATION_ID, repoFullName, raw));
      }
    } else {
      pushWarning("dependabot", depRes);
    }
  }

  // NFR-015: if any category came back as `missing-scope` (HTTP 401), probe
  // the token shape once. Fine-grained PATs and GitHub App tokens do not emit
  // `X-OAuth-Scopes`, so we cannot honestly say `security_events` is missing;
  // rewrite the warning to a graceful "verify scopes" variant instead.
  if (warnings.some((w) => w.code === "missing-scope")) {
    const shape = await probeTokenShape(transport);
    if (shape === "unknown") {
      for (const w of warnings) {
        if (w.code === "missing-scope") {
          w.code = "scope-unverifiable";
          w.cause = SCOPE_UNVERIFIABLE_CAUSE;
          if (w.detail?.missingScope !== undefined) {
            delete w.detail.missingScope;
            if (Object.keys(w.detail).length === 0) {
              delete w.detail;
            }
          }
        }
      }
    }
  }

  return { items, warnings };
}
