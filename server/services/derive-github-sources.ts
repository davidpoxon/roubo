import fs from "node:fs";
import type { RouboConfig, SourceSelection, SourceSelectionEntry } from "@roubo/shared";
import * as projectRegistry from "./project-registry.js";
import * as pluginManager from "./plugin-manager.js";
import { resolveActivePlugin } from "./active-plugin.js";
import { validateConfigObject } from "./config-parser.js";
import { writeRouboConfig } from "./write-roubo-config.js";
import { classifyGitHubError } from "./github-error.js";
import { resolveWithin } from "../lib/safe-path.js";

/**
 * Plugins whose sources are derived from the project's repo (root + resolvable
 * submodules) rather than picked through the host source picker. They share the
 * same `owner/repo` + `owner/#number` source shapes and the same
 * `listSourceCandidates` / `probeRepoAccess` contract, so a single derivation
 * path serves the whole family. Any other active plugin (Jira, third-party)
 * selects sources through the picker and is skipped here.
 */
export const GITHUB_FAMILY_PLUGIN_IDS = new Set(["github-com", "ghe"]);
const REPOSITORY_CATEGORY = "Repository";
const PROJECT_CATEGORY = "Project";

export interface DerivedSourcesPreview {
  repos: string[];
  projects: Array<{ externalId: string; label: string }>;
  alertsRequested: Array<"code-scanning" | "secret-scanning" | "dependabot">;
}

export interface DerivedSourcesResult {
  sources: SourceSelection;
  preview: DerivedSourcesPreview;
}

interface ListedItem {
  externalId: string;
  label: string;
}

interface ListedCategory {
  id: string;
  items: ListedItem[];
}

interface ListSourceCandidatesShape {
  shape?: string;
  categories?: ListedCategory[];
}

interface ProbeRepoAccessShape {
  accessible: boolean;
  status?: number;
  message?: string;
}

/**
 * Returns the GitHub repos that the plugin should treat as issue sources for
 * a project: the root repo declared at `project.repo`, plus every submodule
 * whose `.gitmodules` URL resolves to a parseable `owner/repo` identifier.
 * Submodules whose URLs cannot be resolved are dropped (with a warning) so a
 * single missing remote does not poison the rest of the derivation.
 */
export function collectDesiredRepos(config: RouboConfig, repoPath: string): string[] {
  const out: string[] = [];
  if (config.project.repo) out.push(config.project.repo);

  const declared = config.layout.submodules ?? {};
  if (Object.keys(declared).length > 0) {
    const urlsByAlias = readGitmodulesUrls(repoPath);
    for (const alias of Object.keys(declared)) {
      const url = urlsByAlias.get(alias);
      if (!url) continue;
      const full = parseGitHubRepoFromUrl(url);
      if (full) out.push(full);
    }
  }

  return Array.from(new Set(out));
}

function readGitmodulesUrls(repoPath: string): Map<string, string> {
  const out = new Map<string, string>();
  let filePath: string;
  try {
    // resolveWithin keeps CodeQL's js/path-injection suite happy by enforcing
    // the same `path.relative + startsWith("..")` containment check the rest
    // of server/services uses for caller-provided roots (see safe-path.ts).
    filePath = resolveWithin(repoPath, ".gitmodules");
  } catch {
    return out;
  }
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return out;
  }
  let currentName: string | null = null;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    const section = line.match(/^\[submodule\s+"(.+)"\]$/);
    if (section) {
      currentName = section[1] ?? null;
      continue;
    }
    if (!currentName) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key !== "url") continue;
    const value = line.slice(eq + 1).trim();
    if (value) out.set(currentName, value);
  }
  return out;
}

/**
 * Extracts `owner/repo` from a git remote URL. Mirrors the SSH/HTTPS handling
 * in `git-helpers.resolveRepoFullName` so submodule URLs parse the same way
 * as the root repo's `origin` would.
 */
export function parseGitHubRepoFromUrl(url: string): string | null {
  const sshMatch = url.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];
  const sshPortMatch = url.match(/:\d+\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshPortMatch?.[1]) return sshPortMatch[1];
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.replace(/\.git$/, "").replace(/^\//, "");
    if (parts.includes("/")) return parts;
  } catch {
    // not a URL
  }
  return null;
}

/**
 * Asks the project's active GitHub-family plugin (github-com or ghe) for the
 * authenticated user's repos and projects, then narrows the result to the
 * repos declared on this project (root + every
 * resolvable submodule) and the GitHub Projects (v2) owned by any of those
 * repos' owners. Repository entries carry all three alert flags so the runtime
 * fetches whichever security categories the repo has enabled; the categories
 * the repo doesn't expose surface as `not-enabled` and are silently dropped by
 * the alerts runtime.
 */
export async function deriveGithubSources(projectId: string): Promise<DerivedSourcesResult> {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (!project.config) throw new Error(`Project config invalid: ${projectId}`);

  // Derivation only applies to the GitHub family. Resolve the active plugin and
  // address every RPC to it (not a hard-coded github-com) so GHE projects derive
  // against their own instance. A non-family or absent plugin yields no sources.
  const active = resolveActivePlugin(projectId);
  const pluginId = active?.pluginId;
  if (!pluginId || !GITHUB_FAMILY_PLUGIN_IDS.has(pluginId)) {
    return {
      sources: {},
      preview: { repos: [], projects: [], alertsRequested: [] },
    };
  }

  const desiredRepos = collectDesiredRepos(project.config, project.repoPath);
  if (desiredRepos.length === 0) {
    return {
      sources: {},
      preview: { repos: [], projects: [], alertsRequested: [] },
    };
  }

  const desiredOwners = new Set<string>();
  for (const repo of desiredRepos) {
    const owner = repo.split("/")[0];
    if (owner) desiredOwners.add(owner);
  }

  const raw = await pluginManager.invoke<ListSourceCandidatesShape>(
    pluginId,
    "listSourceCandidates",
    {},
  );

  const categories = Array.isArray(raw?.categories) ? raw.categories : [];
  const repoItems = categories.find((c) => c.id === REPOSITORY_CATEGORY)?.items ?? [];
  const projectItems = categories.find((c) => c.id === PROJECT_CATEGORY)?.items ?? [];

  const available = new Set(repoItems.map((i) => i.externalId));
  const matchedRepos = desiredRepos.filter((r) => available.has(r));

  // Repos that aren't in the candidate list may be genuinely inaccessible, or
  // they may just be missing from it: `/user/repos` is capped/paginated and an
  // org's repos are silently omitted when that org has OAuth App access
  // restrictions Roubo hasn't been approved for. Probe each unmatched repo
  // directly so we can either include it (accessible) or surface the real,
  // actionable error (e.g. ORG_APPROVAL_REQUIRED) instead of a misleading miss.
  const unmatchedRepos = desiredRepos.filter((r) => !available.has(r));
  if (unmatchedRepos.length > 0) {
    const probes = await Promise.all(
      unmatchedRepos.map(async (repo) => {
        try {
          const result = await pluginManager.invoke<ProbeRepoAccessShape>(
            pluginId,
            "probeRepoAccess",
            { repoFullName: repo },
          );
          return { repo, result };
        } catch (err) {
          // A transport-level failure (plugin not enabled, RPC error) is treated
          // like an inaccessible repo with no HTTP status so it still surfaces.
          return {
            repo,
            result: { accessible: false, message: (err as Error).message } as ProbeRepoAccessShape,
          };
        }
      }),
    );

    const firstFailure = probes.find((p) => !p.result.accessible);
    for (const { repo, result } of probes) {
      if (result.accessible) matchedRepos.push(repo);
    }

    // If nothing matched at all, the user is fully blocked from every desired
    // repo: throw the classified error so the route returns an actionable code
    // (the preview UI renders it via GitHubErrorState). When at least one repo
    // matched we keep the partial preview rather than failing the whole thing.
    if (matchedRepos.length === 0 && firstFailure) {
      const owner = firstFailure.repo.split("/")[0];
      throw classifyGitHubError(
        { status: firstFailure.result.status ?? 0, message: firstFailure.result.message ?? "" },
        owner ? { owner } : undefined,
      );
    }
  }

  const repoEntries: SourceSelectionEntry[] = matchedRepos.map((externalId) => ({
    externalId,
    includeCodeQLAlerts: true,
    includeSecretScanningAlerts: true,
    includeDependabotAlerts: true,
  }));

  const matchedProjects = projectItems.filter((item) => {
    const owner = item.externalId.split("/")[0];
    return owner !== undefined && desiredOwners.has(owner);
  });

  const projectEntries: SourceSelectionEntry[] = matchedProjects.map((item) => ({
    externalId: item.externalId,
  }));

  const sources: SourceSelection = {};
  if (repoEntries.length > 0) sources[REPOSITORY_CATEGORY] = repoEntries;
  if (projectEntries.length > 0) sources[PROJECT_CATEGORY] = projectEntries;

  return {
    sources,
    preview: {
      repos: matchedRepos,
      projects: matchedProjects.map((p) => ({ externalId: p.externalId, label: p.label })),
      alertsRequested:
        repoEntries.length > 0 ? ["code-scanning", "secret-scanning", "dependabot"] : [],
    },
  };
}

/**
 * Derives the sources set, then writes it into the project's roubo.yaml
 * `integration.sources` field. Best-effort: any failure (no active
 * GitHub-family plugin, network blip during listSourceCandidates, malformed
 * config) is logged and swallowed so the surrounding field-edit path still
 * succeeds.
 *
 * Returns the preview structure when derivation ran, or `null` when it was
 * skipped or errored. The caller can surface this to the UI but must not
 * gate its own success on it.
 */
export async function deriveAndPersistGithubSources(
  projectId: string,
): Promise<DerivedSourcesPreview | null> {
  let derived: DerivedSourcesResult;
  try {
    derived = await deriveGithubSources(projectId);
  } catch (err) {
    // Use %s placeholders so CodeQL's js/tainted-format-string rule does not
    // flag the user-derived projectId being interpolated into the format
    // string itself.
    console.warn(
      "[derive-github-sources] derivation failed for project %s: %s",
      projectId,
      (err as Error).message,
    );
    return null;
  }

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return derived.preview;

  // Derivation only manages `sources`. The committed `plugin` is preserved
  // verbatim and never fabricated: writing a default `github-com` here is what
  // left GHE projects with a stale `github-com` that only worked because the
  // per-user override resolved to `ghe`. A teammate cloning the repo would then
  // resolve `github-com` against api.github.com and silently break. Promoting
  // the active plugin into committed config is an explicit user action
  // (POST /integration/promote), not a side effect of source derivation.
  const next: RouboConfig = structuredClone(project.config);
  next.integration = { ...(next.integration ?? {}) };
  if (Object.keys(derived.sources).length === 0) {
    delete next.integration.sources;
  } else {
    next.integration.sources = derived.sources;
  }

  const parseResult = validateConfigObject(next);
  if (!parseResult.valid) {
    console.warn(
      "[derive-github-sources] derived sources failed validation for project %s: %s",
      projectId,
      parseResult.fieldErrors?.[0]?.message,
    );
    return derived.preview;
  }

  try {
    writeRouboConfig(project.repoPath, next);
    try {
      projectRegistry.reloadConfig(projectId);
    } catch {
      // Non-fatal: the on-disk write succeeded; the registry will reload on
      // its own cadence.
    }
  } catch (err) {
    console.warn(
      "[derive-github-sources] persisting derived sources failed for project %s: %s",
      projectId,
      (err as Error).message,
    );
  }

  return derived.preview;
}
