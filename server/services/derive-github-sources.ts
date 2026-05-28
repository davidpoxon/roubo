import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import type { RouboConfig, SourceSelection, SourceSelectionEntry } from "@roubo/shared";
import * as projectRegistry from "./project-registry.js";
import * as pluginManager from "./plugin-manager.js";
import { atomicWrite } from "./state.js";
import { validateConfigObject } from "./config-parser.js";

const GITHUB_PLUGIN_ID = "github-com";
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
  const filePath = path.join(repoPath, ".gitmodules");
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
 * Asks the github-com plugin for the authenticated user's repos and projects,
 * then narrows the result to the repos declared on this project (root + every
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
    GITHUB_PLUGIN_ID,
    "listSourceCandidates",
    {},
  );

  const categories = Array.isArray(raw?.categories) ? raw.categories : [];
  const repoItems = categories.find((c) => c.id === REPOSITORY_CATEGORY)?.items ?? [];
  const projectItems = categories.find((c) => c.id === PROJECT_CATEGORY)?.items ?? [];

  const available = new Set(repoItems.map((i) => i.externalId));
  const matchedRepos = desiredRepos.filter((r) => available.has(r));

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
 * `integration.sources` field. Best-effort: any failure (no active github-com
 * plugin, network blip during listSourceCandidates, malformed config) is
 * logged and swallowed so the surrounding field-edit path still succeeds.
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
    console.warn(
      `[derive-github-sources] derivation failed for project ${projectId}:`,
      (err as Error).message,
    );
    return null;
  }

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return derived.preview;

  const next: RouboConfig = structuredClone(project.config);
  const existing = next.integration ?? { plugin: GITHUB_PLUGIN_ID };
  next.integration = {
    ...existing,
    plugin: existing.plugin ?? GITHUB_PLUGIN_ID,
  };
  if (Object.keys(derived.sources).length === 0) {
    delete next.integration.sources;
  } else {
    next.integration.sources = derived.sources;
  }

  const parseResult = validateConfigObject(next);
  if (!parseResult.valid) {
    console.warn(
      `[derive-github-sources] derived sources failed validation for project ${projectId}:`,
      parseResult.fieldErrors?.[0]?.message,
    );
    return derived.preview;
  }

  try {
    writeConfig(project.repoPath, next);
    try {
      projectRegistry.reloadConfig(projectId);
    } catch {
      // Non-fatal: the on-disk write succeeded; the registry will reload on
      // its own cadence.
    }
  } catch (err) {
    console.warn(
      `[derive-github-sources] persisting derived sources failed for project ${projectId}:`,
      (err as Error).message,
    );
  }

  return derived.preview;
}

function writeConfig(repoPath: string, config: RouboConfig): void {
  const repoRoot = path.resolve(repoPath);
  const dir = path.resolve(repoRoot, ".roubo");
  if (dir !== path.join(repoRoot, ".roubo")) {
    throw new Error("Resolved config directory escaped the project root");
  }
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "roubo.yaml");
  const yamlContent = YAML.stringify(config, {
    indent: 2,
    lineWidth: 0,
    defaultStringType: "QUOTE_DOUBLE",
    defaultKeyType: "PLAIN",
  });
  atomicWrite(configPath, yamlContent);
}
