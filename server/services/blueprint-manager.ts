import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import { GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";
import type {
  BlueprintMeta,
  BlueprintDetail,
  BlueprintSource,
  BlueprintDefaultSource,
  UserPreferences,
  BlueprintCreateRequest,
  BlueprintUpdateRequest,
  BlueprintReference,
} from "@roubo/shared";
import { resolveTemplate } from "./config-parser.js";
import type { ResolvedTemplateContext } from "./config-parser.js";
import { loadSettings, getRouboDir } from "./state.js";
import * as projectRegistry from "./project-registry.js";
import { cloneGlobalDefault } from "./global-default-blueprint.js";

const SOFT_SIZE_LIMIT = 50 * 1024; // 50 KB
const HARD_SIZE_LIMIT = 200 * 1024; // 200 KB

// Cache TTL — a safety net for cases where file watchers miss events
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  data: BlueprintMeta[];
  timestamp: number;
}

// Cache: projectId -> resolved blueprint list with timestamp
const blueprintCache = new Map<string, CacheEntry>();

const watcherMap = new Map<string, fs.FSWatcher>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface BlueprintResolveContext extends ResolvedTemplateContext {
  benchBranch?: string;
  benchId?: number;
  projectName?: string;
  issueNumber?: number;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
  comments?: string;
}

function getAppBlueprintsDir(): string {
  return path.join(getRouboDir(), "blueprints");
}

function getRepoBlueprintsDir(repoPath: string): string {
  return path.join(repoPath, ".roubo/blueprints");
}

interface ParsedFrontmatter {
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export function loadBlueprintFile(filePath: string): BlueprintDetail | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const sizeBytes = stat.size;

  if (sizeBytes > HARD_SIZE_LIMIT) {
    console.error(
      `[blueprint-manager] Blueprint file too large (${sizeBytes} bytes), rejecting: ${filePath}`,
    );
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  // Parse YAML frontmatter: split on first two --- delimiters
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    console.warn(`[blueprint-manager] Blueprint has no valid frontmatter, skipping: ${filePath}`);
    return null;
  }

  const [, frontmatterStr, body] = frontmatterMatch;

  let frontmatter: ParsedFrontmatter;
  try {
    frontmatter = (YAML.parse(frontmatterStr) as ParsedFrontmatter) ?? {};
  } catch (err) {
    console.warn(
      `[blueprint-manager] Invalid frontmatter YAML in ${filePath}: ${(err as Error).message}`,
    );
    return null;
  }

  const name = typeof frontmatter.name === "string" ? frontmatter.name : null;
  const description = typeof frontmatter.description === "string" ? frontmatter.description : null;

  if (!name || !description) {
    console.warn(
      `[blueprint-manager] Blueprint missing required frontmatter fields (name, description): ${filePath}`,
    );
    return null;
  }

  const icon = typeof frontmatter.icon === "string" ? frontmatter.icon : "file-text";
  const id = path.basename(filePath, ".md");
  const createdAt = typeof frontmatter.createdAt === "string" ? frontmatter.createdAt : undefined;
  const updatedAt = typeof frontmatter.updatedAt === "string" ? frontmatter.updatedAt : undefined;

  if (sizeBytes > SOFT_SIZE_LIMIT) {
    console.warn(`[blueprint-manager] Blueprint file is large (${sizeBytes} bytes): ${filePath}`);
  }

  const content = body.trimStart();
  return {
    id,
    name,
    description,
    icon,
    source: "app", // will be overridden by caller
    content,
    sizeBytes,
    sizeWarning: sizeBytes > SOFT_SIZE_LIMIT,
    approxTokens: Math.ceil(Buffer.byteLength(content, "utf-8") / 4),
    ...(createdAt !== undefined && { createdAt }),
    ...(updatedAt !== undefined && { updatedAt }),
  };
}

function loadBlueprintsFromDir(dir: string, source: BlueprintSource): Map<string, BlueprintDetail> {
  const result = new Map<string, BlueprintDetail>();

  if (!fs.existsSync(dir)) return result;

  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return result;
  }

  for (const file of files) {
    const filePath = path.join(dir, file);
    const blueprint = loadBlueprintFile(filePath);
    if (blueprint) {
      blueprint.source = source;
      result.set(blueprint.id, blueprint);
    }
  }

  return result;
}

function mergeUserGlobal(merged: Map<string, BlueprintDetail>): void {
  for (const [id, blueprint] of loadBlueprintsFromDir(getAppBlueprintsDir(), "app")) {
    if (id === GLOBAL_DEFAULT_BLUEPRINT_ID) {
      console.warn(
        `[blueprint-manager] Ignoring user blueprint with reserved id '${GLOBAL_DEFAULT_BLUEPRINT_ID}'`,
      );
      continue;
    }
    merged.set(id, blueprint);
  }
}

function resolveBlueprintsForProject(projectId: string): BlueprintDetail[] {
  const project = projectRegistry.getProject(projectId);
  const repoPath = project?.repoPath;

  // Seed with the embedded global default first (appears first in UI lists)
  const merged = new Map<string, BlueprintDetail>([
    [GLOBAL_DEFAULT_BLUEPRINT_ID, cloneGlobalDefault()],
  ]);

  // Layer 2: user-global ~/.roubo/blueprints/ (cannot override __global_default__)
  mergeUserGlobal(merged);

  // Layer 1 (highest): project-level blueprints (repo-local, cannot override __global_default__)
  if (repoPath) {
    for (const [id, blueprint] of loadBlueprintsFromDir(
      getRepoBlueprintsDir(repoPath),
      "project",
    )) {
      if (id === GLOBAL_DEFAULT_BLUEPRINT_ID) {
        console.warn(
          `[blueprint-manager] Ignoring repo blueprint with reserved id '${GLOBAL_DEFAULT_BLUEPRINT_ID}'`,
        );
        continue;
      }
      merged.set(id, blueprint);
    }
  }

  return Array.from(merged.values());
}

/** Returns app-level blueprints without requiring a projectId (used by global settings UI). */
export function listGlobalBlueprints(): BlueprintMeta[] {
  const merged = new Map<string, BlueprintDetail>([
    [GLOBAL_DEFAULT_BLUEPRINT_ID, cloneGlobalDefault()],
  ]);
  mergeUserGlobal(merged);
  return Array.from(merged.values()).map(
    ({ content: _c, sizeBytes: _s, sizeWarning: _w, ...m }) => m,
  );
}

export function listBlueprintsForProject(projectId: string): BlueprintMeta[] {
  const cached = blueprintCache.get(projectId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const blueprints = resolveBlueprintsForProject(projectId);
  const meta = blueprints.map(
    ({ content: _content, sizeBytes: _sizeBytes, sizeWarning: _sizeWarning, ...m }) => m,
  );
  blueprintCache.set(projectId, { data: meta, timestamp: Date.now() });
  return meta;
}

export function getBlueprint(projectId: string, blueprintId: string): BlueprintDetail | null {
  // The embedded global default is always resolvable without filesystem access
  if (blueprintId === GLOBAL_DEFAULT_BLUEPRINT_ID) return cloneGlobalDefault();

  const meta = listBlueprintsForProject(projectId);
  const target = meta.find((p) => p.id === blueprintId);
  if (!target) return null;

  const project = projectRegistry.getProject(projectId);
  let dir: string;
  if (target.source === "project") {
    dir = getRepoBlueprintsDir(project?.repoPath ?? "");
  } else {
    dir = getAppBlueprintsDir();
  }

  const detail = loadBlueprintFile(path.join(dir, `${blueprintId}.md`));
  if (detail) detail.source = target.source;
  return detail;
}

export function resolveBlueprintContent(content: string, ctx: BlueprintResolveContext): string {
  // First pass: resolve config-parser variables (ports, urls, workspace, components)
  const resolved = resolveTemplate(content, ctx);

  // Second pass: resolve blueprint-specific and issue variables
  return resolved.replace(/\{\{([^}]+)\}\}/g, (match, expr: string) => {
    const key = expr.trim();
    switch (key) {
      case "bench.branch":
      case "slot.branch":
        return ctx.benchBranch ?? match; // slot.branch is a deprecated alias
      case "bench.id":
      case "slot.id":
        return ctx.benchId !== undefined ? String(ctx.benchId) : match; // slot.id is a deprecated alias
      case "project.name":
      case "app.name":
        return ctx.projectName ?? match; // app.name is a deprecated alias
      // Issue variables intentionally resolve to empty strings when missing, unlike
      // bench/project variables which preserve the {{placeholder}}. When a blueprint is
      // injected without issue context (e.g. manually from TerminalTabs), raw
      // {{issueNumber}} etc. in the terminal would be confusing.
      case "issueNumber":
        return ctx.issueNumber !== undefined ? String(ctx.issueNumber) : "";
      case "issueTitle":
        return ctx.issueTitle ?? "";
      case "issueBody":
        return ctx.issueBody ?? "";
      case "issueUrl":
        return ctx.issueUrl ?? "";
      case "comments":
        return ctx.comments ?? "";
      default:
        return match;
    }
  });
}

export function resolveEffectiveDefaultBlueprint(
  projectId: string,
  settings?: UserPreferences,
): { blueprintId: string; source: BlueprintDefaultSource } {
  const project = projectRegistry.getProject(projectId);
  const blueprints = listBlueprintsForProject(projectId);

  // Tier 1: project-level default from roubo.yaml (blueprints.defaultBlueprint).
  // Note: the legacy field project.blueprintSettings.defaultBlueprintId is intentionally
  // not checked here — it predates the new hierarchy and no production configs are known
  // to use it. findProjectBlueprintReferences still guards it for safe deletion, which
  // means a blueprint set via the legacy field will block deletion but won't influence
  // resolution. Widen this check if legacy configs ever need to be supported.
  const projectDefault = project?.config?.blueprints?.defaultBlueprint;
  if (projectDefault) {
    if (
      projectDefault === GLOBAL_DEFAULT_BLUEPRINT_ID ||
      blueprints.some((b) => b.id === projectDefault)
    ) {
      return { blueprintId: projectDefault, source: "project" };
    }
    console.warn(
      `[blueprint-manager] Configured project default blueprint '${projectDefault}' not found; falling through to app default`,
    );
  }

  // Tier 2: app-level default from settings.json
  const s = settings ?? loadSettings();
  const appDefault = s.blueprints?.defaultBlueprintId;
  if (appDefault) {
    if (appDefault === GLOBAL_DEFAULT_BLUEPRINT_ID || blueprints.some((b) => b.id === appDefault)) {
      return { blueprintId: appDefault, source: "app" };
    }
    console.warn(
      `[blueprint-manager] Configured app default blueprint '${appDefault}' not found; falling through to global default`,
    );
  }

  // Tier 3: embedded global default
  return { blueprintId: GLOBAL_DEFAULT_BLUEPRINT_ID, source: "global" };
}

export function getDefaultBlueprintId(projectId: string, settings?: UserPreferences): string {
  return resolveEffectiveDefaultBlueprint(projectId, settings).blueprintId;
}

export function resolveBlueprintForIssue(
  projectId: string,
  issueType: string | undefined,
  settings?: UserPreferences,
): { blueprintId: string; source: BlueprintDefaultSource } {
  if (issueType) {
    const project = projectRegistry.getProject(projectId);
    // Note: legacy field project.blueprintSettings.issueTypeMappings is intentionally not
    // checked here (same rationale as resolveEffectiveDefaultBlueprint — no production configs
    // are known to use it). findProjectBlueprintReferences still guards it for safe deletion.
    const mapped = project?.config?.blueprints?.issueTypeMappings?.[issueType];
    if (mapped) {
      if (mapped === GLOBAL_DEFAULT_BLUEPRINT_ID) {
        return { blueprintId: mapped, source: "issue-type-mapping" };
      }
      const blueprints = listBlueprintsForProject(projectId);
      if (blueprints.some((b) => b.id === mapped)) {
        return { blueprintId: mapped, source: "issue-type-mapping" };
      }
      console.warn(
        `[blueprint-manager] Mapped blueprint '${mapped}' for issue type '${issueType}' not found; falling through to default hierarchy`,
      );
    }
  }
  return resolveEffectiveDefaultBlueprint(projectId, settings);
}

export function invalidateCache(projectId?: string): void {
  if (projectId) {
    blueprintCache.delete(projectId);
  } else {
    blueprintCache.clear();
  }
}

function debounceReload(key: string, projectId?: string): void {
  const existing = debounceTimers.get(key);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      invalidateCache(projectId);
    }, 500),
  );
}

export function startWatchers(projectId: string, repoPath: string): void {
  const repoDir = getRepoBlueprintsDir(repoPath);

  const key = `repo:${projectId}`;
  watcherMap.get(key)?.close();

  try {
    watcherMap.set(
      key,
      fs.watch(repoDir, () => {
        debounceReload(key, projectId);
      }),
    );
  } catch (err: unknown) {
    // ENOENT is expected when the repo has no .roubo/blueprints/ directory yet.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[blueprint-manager] Failed to watch ${repoDir}: ${(err as Error).message}`);
    }
  }
}

export function startAppBlueprintsWatcher(): void {
  const projectDir = getAppBlueprintsDir();
  fs.mkdirSync(projectDir, { recursive: true });

  const key = "app-blueprints";
  watcherMap.get(key)?.close();

  try {
    watcherMap.set(
      key,
      fs.watch(projectDir, () => {
        debounceReload(key, undefined);
      }),
    );
  } catch (err: unknown) {
    // mkdirSync runs just above, so ENOENT is not expected here.
    if (err instanceof Error) {
      console.warn(`[blueprint-manager] Failed to watch ${projectDir}: ${err.message}`);
    }
  }
}

export function stopAllWatchers(): void {
  for (const watcher of watcherMap.values()) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
  }
  watcherMap.clear();
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}

// ── Blueprint CRUD — shared types and helpers ──

type BlueprintErrorCode =
  | "NOT_FOUND"
  | "RESERVED_ID"
  | "DUPLICATE_ID"
  | "DUPLICATE_NAME"
  | "INVALID_NAME"
  | "INVALID_DESCRIPTION"
  | "INVALID_ICON"
  | "INVALID_CONTENT"
  | "REFERENCED";

export class BlueprintError extends Error {
  constructor(
    message: string,
    public code: BlueprintErrorCode,
    public data?: BlueprintReference[],
  ) {
    super(message);
    this.name = "BlueprintError";
  }
}

/** Converts a display name to a filesystem-safe slug used as the blueprint ID. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function writeBlueprintFile(
  dir: string,
  id: string,
  {
    name,
    description,
    icon,
    createdAt,
    updatedAt,
  }: { name: string; description: string; icon: string; createdAt: string; updatedAt: string },
  content: string,
): number {
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = YAML.stringify(
    { name, description, icon, createdAt, updatedAt },
    { lineWidth: 0 },
  );
  const body = `---\n${frontmatter}---\n${content.endsWith("\n") ? content : content + "\n"}`;
  const filePath = path.join(dir, `${id}.md`);
  fs.writeFileSync(filePath, body, "utf-8");
  return fs.statSync(filePath).size;
}

function validateBlueprintFields(
  fields: { name?: string; description?: string; icon?: string; content?: string },
  context: "create" | "update",
): void {
  if (context === "create" || fields.name !== undefined) {
    if (typeof fields.name !== "string" || fields.name.trim().length === 0) {
      throw new BlueprintError("name is required", "INVALID_NAME");
    }
    if (fields.name.trim().length > 100) {
      throw new BlueprintError("name must be 100 characters or fewer", "INVALID_NAME");
    }
  }
  if (context === "create" || fields.description !== undefined) {
    if (typeof fields.description !== "string" || fields.description.trim().length === 0) {
      throw new BlueprintError("description is required", "INVALID_DESCRIPTION");
    }
    if (fields.description.trim().length > 300) {
      throw new BlueprintError(
        "description must be 300 characters or fewer",
        "INVALID_DESCRIPTION",
      );
    }
  }
  if (fields.icon !== undefined) {
    if (typeof fields.icon !== "string" || fields.icon.trim().length === 0) {
      throw new BlueprintError("icon must be a non-empty string", "INVALID_ICON");
    }
  }
  if (context === "create" || fields.content !== undefined) {
    if (typeof fields.content !== "string" || fields.content.trim().length === 0) {
      throw new BlueprintError("content is required", "INVALID_CONTENT");
    }
    if (Buffer.byteLength(fields.content, "utf-8") > HARD_SIZE_LIMIT) {
      throw new BlueprintError(
        `content exceeds the maximum size of ${HARD_SIZE_LIMIT / 1024} KB`,
        "INVALID_CONTENT",
      );
    }
  }
}

// ── Scope-agnostic internal helpers ──
// These take an explicit `dir` and `source` so both app-scope and project-scope
// wrappers can share identical validation, dup-check, and write logic.

function _createBlueprintInDir(
  dir: string,
  source: BlueprintSource,
  req: BlueprintCreateRequest,
): BlueprintDetail {
  validateBlueprintFields(req, "create");

  const id = slugify(req.name.trim());
  if (!id)
    throw new BlueprintError(
      "name produces an empty slug — use alphanumeric characters",
      "INVALID_NAME",
    );
  if (id === GLOBAL_DEFAULT_BLUEPRINT_ID || id === "default")
    throw new BlueprintError(`'${id}' is a reserved blueprint id`, "RESERVED_ID");

  // Dup checks are scoped to `dir` only — a project blueprint CAN share an id
  // with an app blueprint (the project layer overrides at lookup time).
  const existing = loadBlueprintsFromDir(dir, source);
  if (existing.has(id)) {
    throw new BlueprintError(`A blueprint with id '${id}' already exists`, "DUPLICATE_ID");
  }
  const nameLower = req.name.trim().toLowerCase();
  for (const bp of existing.values()) {
    if (bp.name.toLowerCase() === nameLower) {
      throw new BlueprintError(`A blueprint named '${bp.name}' already exists`, "DUPLICATE_NAME");
    }
  }

  const icon = req.icon?.trim() || "file-text";
  const name = req.name.trim();
  const description = req.description.trim();
  const { content } = req;
  const now = new Date().toISOString();
  const sizeBytes = writeBlueprintFile(
    dir,
    id,
    { name, description, icon, createdAt: now, updatedAt: now },
    content,
  );

  return {
    id,
    name,
    description,
    icon,
    source,
    content,
    sizeBytes,
    sizeWarning: sizeBytes > SOFT_SIZE_LIMIT,
    approxTokens: Math.ceil(Buffer.byteLength(content, "utf-8") / 4),
    createdAt: now,
    updatedAt: now,
  };
}

function _updateBlueprintInDir(
  dir: string,
  source: BlueprintSource,
  id: string,
  req: BlueprintUpdateRequest,
): BlueprintDetail {
  if (id === GLOBAL_DEFAULT_BLUEPRINT_ID) {
    throw new BlueprintError("The built-in default blueprint cannot be modified", "RESERVED_ID");
  }

  const filePath = path.join(dir, `${id}.md`);
  const existing = loadBlueprintFile(filePath);
  if (!existing) throw new BlueprintError(`Blueprint '${id}' not found`, "NOT_FOUND");

  validateBlueprintFields(req, "update");

  if (req.name !== undefined) {
    const nameLower = req.name.trim().toLowerCase();
    if (nameLower !== existing.name.toLowerCase()) {
      for (const bp of loadBlueprintsFromDir(dir, source).values()) {
        if (bp.id !== id && bp.name.toLowerCase() === nameLower) {
          throw new BlueprintError(
            `A blueprint named '${bp.name}' already exists`,
            "DUPLICATE_NAME",
          );
        }
      }
    }
  }

  const now = new Date().toISOString();
  const name = req.name !== undefined ? req.name.trim() : existing.name;
  const description = req.description !== undefined ? req.description.trim() : existing.description;
  const icon = req.icon !== undefined ? req.icon.trim() : existing.icon;
  const content = req.content !== undefined ? req.content : existing.content;
  const createdAt = existing.createdAt ?? now;
  const sizeBytes = writeBlueprintFile(
    dir,
    id,
    { name, description, icon, createdAt, updatedAt: now },
    content,
  );

  return {
    id,
    name,
    description,
    icon,
    source,
    content,
    sizeBytes,
    sizeWarning: sizeBytes > SOFT_SIZE_LIMIT,
    approxTokens: Math.ceil(Buffer.byteLength(content, "utf-8") / 4),
    createdAt,
    updatedAt: now,
  };
}

function _deleteBlueprintInDir(dir: string, id: string, references: BlueprintReference[]): void {
  if (id === GLOBAL_DEFAULT_BLUEPRINT_ID) {
    throw new BlueprintError("The built-in default blueprint cannot be deleted", "RESERVED_ID");
  }

  const filePath = path.join(dir, `${id}.md`);
  if (!fs.existsSync(filePath)) {
    throw new BlueprintError(`Blueprint '${id}' not found`, "NOT_FOUND");
  }

  if (references.length > 0) {
    throw new BlueprintError(
      "Blueprint is still referenced and cannot be deleted",
      "REFERENCED",
      references,
    );
  }

  fs.unlinkSync(filePath);
}

// ── App-level blueprint CRUD ──

export function createAppBlueprint(req: BlueprintCreateRequest): BlueprintDetail {
  const detail = _createBlueprintInDir(getAppBlueprintsDir(), "app", req);
  invalidateCache();
  return detail;
}

export function updateAppBlueprint(id: string, req: BlueprintUpdateRequest): BlueprintDetail {
  const detail = _updateBlueprintInDir(getAppBlueprintsDir(), "app", id, req);
  invalidateCache();
  return detail;
}

export function deleteAppBlueprint(id: string): void {
  const refs = findAppBlueprintReferences(id);
  _deleteBlueprintInDir(getAppBlueprintsDir(), id, refs);
  invalidateCache();
}

/** Returns a blueprint by id from app scope, or null if not found. */
export function getAppBlueprint(id: string): BlueprintDetail | null {
  if (id === GLOBAL_DEFAULT_BLUEPRINT_ID) return cloneGlobalDefault();

  const filePath = path.join(getAppBlueprintsDir(), `${id}.md`);
  const detail = loadBlueprintFile(filePath);
  if (detail) detail.source = "app";
  return detail;
}

/** Finds all references to an app-level blueprint across all projects and the user-global setting. */
export function findAppBlueprintReferences(id: string): BlueprintReference[] {
  const refs: BlueprintReference[] = [];

  const settings = loadSettings();
  if (settings.blueprints?.defaultBlueprintId === id) {
    refs.push({ type: "app-default" });
  }

  for (const project of projectRegistry.getProjects()) {
    let pushedProjectDefault = false;

    if (project.config?.blueprints?.defaultBlueprint === id) {
      refs.push({
        type: "project-default",
        projectId: project.id,
        projectName: project.config.project.displayName,
      });
      pushedProjectDefault = true;
    }

    if (
      !pushedProjectDefault &&
      project.config?.project?.blueprintSettings?.defaultBlueprintId === id
    ) {
      refs.push({
        type: "project-default",
        projectId: project.id,
        projectName: project.config.project.displayName,
      });
    }

    const topLevelMappings = project.config?.blueprints?.issueTypeMappings;
    const legacyMappings = project.config?.project?.blueprintSettings?.issueTypeMappings;
    const projectName = project.config?.project.displayName ?? project.id;
    for (const mappings of [topLevelMappings, legacyMappings]) {
      if (mappings) {
        for (const [issueType, blueprintId] of Object.entries(mappings)) {
          if (blueprintId === id) {
            refs.push({
              type: "issue-type-mapping",
              projectId: project.id,
              projectName,
              issueType,
            });
          }
        }
      }
    }
  }

  return refs;
}

// ── Project-level blueprint CRUD ──

export function createProjectBlueprint(
  projectId: string,
  req: BlueprintCreateRequest,
): BlueprintDetail {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new BlueprintError(`Project '${projectId}' not found`, "NOT_FOUND");
  const detail = _createBlueprintInDir(getRepoBlueprintsDir(project.repoPath), "project", req);
  invalidateCache(projectId);
  return detail;
}

export function updateProjectBlueprint(
  projectId: string,
  id: string,
  req: BlueprintUpdateRequest,
): BlueprintDetail {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new BlueprintError(`Project '${projectId}' not found`, "NOT_FOUND");
  const detail = _updateBlueprintInDir(getRepoBlueprintsDir(project.repoPath), "project", id, req);
  invalidateCache(projectId);
  return detail;
}

export function deleteProjectBlueprint(projectId: string, id: string): void {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new BlueprintError(`Project '${projectId}' not found`, "NOT_FOUND");
  const refs = findProjectBlueprintReferences(projectId, id);
  _deleteBlueprintInDir(getRepoBlueprintsDir(project.repoPath), id, refs);
  invalidateCache(projectId);
}

/** Returns a blueprint by id from project scope only, or null if not found. */
export function getProjectBlueprint(projectId: string, id: string): BlueprintDetail | null {
  if (id === GLOBAL_DEFAULT_BLUEPRINT_ID) return null; // reserved id never lives in a repo

  const project = projectRegistry.getProject(projectId);
  if (!project) return null;

  const filePath = path.join(getRepoBlueprintsDir(project.repoPath), `${id}.md`);
  const detail = loadBlueprintFile(filePath);
  if (detail) detail.source = "project";
  return detail;
}

/** Finds references to a project-level blueprint within that project's own roubo.yaml. */
export function findProjectBlueprintReferences(
  projectId: string,
  id: string,
): BlueprintReference[] {
  const refs: BlueprintReference[] = [];
  const project = projectRegistry.getProject(projectId);
  if (!project) return refs;

  const projectName = project.config?.project.displayName ?? project.id;
  let pushedProjectDefault = false;

  if (project.config?.blueprints?.defaultBlueprint === id) {
    refs.push({ type: "project-default", projectId, projectName });
    pushedProjectDefault = true;
  }

  if (
    !pushedProjectDefault &&
    project.config?.project?.blueprintSettings?.defaultBlueprintId === id
  ) {
    refs.push({ type: "project-default", projectId, projectName });
  }

  const topLevelMappings = project.config?.blueprints?.issueTypeMappings;
  const legacyMappings = project.config?.project?.blueprintSettings?.issueTypeMappings;
  for (const mappings of [topLevelMappings, legacyMappings]) {
    if (mappings) {
      for (const [issueType, blueprintId] of Object.entries(mappings)) {
        if (blueprintId === id) {
          refs.push({ type: "issue-type-mapping", projectId, projectName, issueType });
        }
      }
    }
  }

  return refs;
}
