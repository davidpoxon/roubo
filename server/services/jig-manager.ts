import fs from "node:fs";
import path from "node:path";
import * as YAML from "yaml";
import { GLOBAL_DEFAULT_JIG_ID } from "@roubo/shared";
import type {
  JigMeta,
  JigDetail,
  JigSource,
  JigDefaultSource,
  UserPreferences,
  JigCreateRequest,
  JigUpdateRequest,
  JigReference,
} from "@roubo/shared";
import { resolveTemplate } from "./config-parser.js";
import type { ResolvedTemplateContext } from "./config-parser.js";
import { loadSettings, getRouboDir } from "./state.js";
import * as projectRegistry from "./project-registry.js";
import { cloneGlobalDefault } from "./global-default-jig.js";
import { JIG_ID_RE, assertSafeIdentifier, resolveWithin } from "../lib/safe-path.js";

const SOFT_SIZE_LIMIT = 50 * 1024; // 50 KB
const HARD_SIZE_LIMIT = 200 * 1024; // 200 KB

// Cache TTL: a safety net for cases where file watchers miss events
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  data: JigMeta[];
  timestamp: number;
}

// Cache: projectId -> resolved jig list with timestamp
const jigCache = new Map<string, CacheEntry>();

const watcherMap = new Map<string, fs.FSWatcher>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export interface JigResolveContext extends ResolvedTemplateContext {
  benchBranch?: string;
  benchId?: number;
  projectName?: string;
  issueNumber?: number;
  issueKey?: string;
  issueTitle?: string;
  issueBody?: string;
  issueUrl?: string;
  comments?: string;
}

/**
 * One-shot rename of a legacy `<parent>/blueprints/` directory to
 * `<parent>/jigs/`. Runs at most once per process per parent: if the new
 * path exists, the legacy path is left alone (we never merge or overwrite).
 */
const migratedParents = new Set<string>();
function migrateLegacyJigsDir(parent: string): void {
  if (migratedParents.has(parent)) return;
  migratedParents.add(parent);
  const legacyDir = resolveWithin(parent, "blueprints");
  const targetDir = resolveWithin(parent, "jigs");
  if (!fs.existsSync(legacyDir)) return;
  if (fs.existsSync(targetDir)) return;
  try {
    fs.renameSync(legacyDir, targetDir);
    console.log(`[jig-manager] Migrated legacy directory ${legacyDir} -> ${targetDir}`);
  } catch (err) {
    console.warn(`[jig-manager] Failed to migrate ${legacyDir} -> ${targetDir}:`, err);
  }
}

function getAppJigsDir(): string {
  migrateLegacyJigsDir(getRouboDir());
  return resolveWithin(getRouboDir(), "jigs");
}

function getRepoJigsDir(repoPath: string): string {
  const rouboDir = resolveWithin(repoPath, ".roubo");
  migrateLegacyJigsDir(rouboDir);
  return resolveWithin(rouboDir, "jigs");
}

interface ParsedFrontmatter {
  name?: unknown;
  description?: unknown;
  icon?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export function loadJigFile(filePath: string): JigDetail | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  const sizeBytes = stat.size;

  if (sizeBytes > HARD_SIZE_LIMIT) {
    console.error(`[jig-manager] Jig file too large (${sizeBytes} bytes), rejecting: ${filePath}`);
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
    console.warn(`[jig-manager] Jig has no valid frontmatter, skipping: ${filePath}`);
    return null;
  }

  const [, frontmatterStr, body] = frontmatterMatch;

  let frontmatter: ParsedFrontmatter;
  try {
    frontmatter = (YAML.parse(frontmatterStr) as ParsedFrontmatter) ?? {};
  } catch (err) {
    console.warn(
      `[jig-manager] Invalid frontmatter YAML in ${filePath}: ${(err as Error).message}`,
    );
    return null;
  }

  const name = typeof frontmatter.name === "string" ? frontmatter.name : null;
  const description = typeof frontmatter.description === "string" ? frontmatter.description : null;

  if (!name || !description) {
    console.warn(
      `[jig-manager] Jig missing required frontmatter fields (name, description): ${filePath}`,
    );
    return null;
  }

  const icon = typeof frontmatter.icon === "string" ? frontmatter.icon : "file-text";
  const id = path.basename(filePath, ".md");
  const createdAt = typeof frontmatter.createdAt === "string" ? frontmatter.createdAt : undefined;
  const updatedAt = typeof frontmatter.updatedAt === "string" ? frontmatter.updatedAt : undefined;

  if (sizeBytes > SOFT_SIZE_LIMIT) {
    console.warn(`[jig-manager] Jig file is large (${sizeBytes} bytes): ${filePath}`);
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

function loadJigsFromDir(dir: string, source: JigSource): Map<string, JigDetail> {
  const result = new Map<string, JigDetail>();

  // Re-confine via path.resolve before any fs op so CodeQL sees a sanitizer
  // on `dir` even if interprocedural taint analysis missed the caller's
  // resolveWithin.
  const resolvedDir = path.resolve(dir);
  if (!fs.existsSync(resolvedDir)) return result;

  let files: string[];
  try {
    files = fs.readdirSync(resolvedDir).filter((f) => f.endsWith(".md"));
  } catch {
    return result;
  }

  for (const file of files) {
    let filePath: string;
    try {
      filePath = resolveWithin(resolvedDir, file);
    } catch {
      continue;
    }
    const jig = loadJigFile(filePath);
    if (jig) {
      jig.source = source;
      result.set(jig.id, jig);
    }
  }

  return result;
}

function mergeUserGlobal(merged: Map<string, JigDetail>): void {
  for (const [id, jig] of loadJigsFromDir(getAppJigsDir(), "app")) {
    if (id === GLOBAL_DEFAULT_JIG_ID) {
      console.warn(`[jig-manager] Ignoring user jig with reserved id '${GLOBAL_DEFAULT_JIG_ID}'`);
      continue;
    }
    merged.set(id, jig);
  }
}

function resolveJigsForProject(projectId: string): JigDetail[] {
  const project = projectRegistry.getProject(projectId);
  const repoPath = project?.repoPath;

  // Seed with the embedded global default first (appears first in UI lists)
  const merged = new Map<string, JigDetail>([[GLOBAL_DEFAULT_JIG_ID, cloneGlobalDefault()]]);

  // Layer 2: user-global ~/.roubo/jigs/ (cannot override __global_default__)
  mergeUserGlobal(merged);

  // Layer 1 (highest): project-level jigs (repo-local, cannot override __global_default__)
  if (repoPath) {
    for (const [id, jig] of loadJigsFromDir(getRepoJigsDir(repoPath), "project")) {
      if (id === GLOBAL_DEFAULT_JIG_ID) {
        console.warn(`[jig-manager] Ignoring repo jig with reserved id '${GLOBAL_DEFAULT_JIG_ID}'`);
        continue;
      }
      merged.set(id, jig);
    }
  }

  return Array.from(merged.values());
}

/** Returns app-level jigs without requiring a projectId (used by global settings UI). */
export function listGlobalJigs(): JigMeta[] {
  const merged = new Map<string, JigDetail>([[GLOBAL_DEFAULT_JIG_ID, cloneGlobalDefault()]]);
  mergeUserGlobal(merged);
  return Array.from(merged.values()).map(
    ({ content: _c, sizeBytes: _s, sizeWarning: _w, ...m }) => m,
  );
}

export function listJigsForProject(projectId: string): JigMeta[] {
  const cached = jigCache.get(projectId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) return cached.data;

  const jigs = resolveJigsForProject(projectId);
  const meta = jigs.map(
    ({ content: _content, sizeBytes: _sizeBytes, sizeWarning: _sizeWarning, ...m }) => m,
  );
  jigCache.set(projectId, { data: meta, timestamp: Date.now() });
  return meta;
}

export function getJig(projectId: string, jigId: string): JigDetail | null {
  // The embedded global default is always resolvable without filesystem access
  if (jigId === GLOBAL_DEFAULT_JIG_ID) return cloneGlobalDefault();

  const meta = listJigsForProject(projectId);
  const target = meta.find((p) => p.id === jigId);
  if (!target) return null;

  const project = projectRegistry.getProject(projectId);
  let dir: string;
  if (target.source === "project") {
    dir = getRepoJigsDir(project?.repoPath ?? "");
  } else {
    dir = getAppJigsDir();
  }

  assertSafeIdentifier(jigId, JIG_ID_RE, "jigId");
  const detail = loadJigFile(resolveWithin(dir, `${jigId}.md`));
  if (detail) detail.source = target.source;
  return detail;
}

export function resolveJigContent(content: string, ctx: JigResolveContext): string {
  // First pass: resolve config-parser variables (ports, urls, workspace, components)
  const resolved = resolveTemplate(content, ctx);

  // Second pass: resolve jig-specific and issue variables
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
      // bench/project variables which preserve the {{placeholder}}. When a jig is
      // injected without issue context (e.g. manually from TerminalTabs), raw
      // {{issueNumber}} etc. in the terminal would be confusing.
      case "issueNumber":
        return ctx.issueNumber !== undefined ? String(ctx.issueNumber) : "";
      case "issueKey":
        return ctx.issueKey ?? "";
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

export function resolveEffectiveDefaultJig(
  projectId: string,
  settings?: UserPreferences,
): { jigId: string; source: JigDefaultSource } {
  const project = projectRegistry.getProject(projectId);
  const jigs = listJigsForProject(projectId);

  // Tier 1: project-level default from roubo.yaml (jigs.defaultJig).
  // Note: the legacy field project.jigSettings.defaultJigId is intentionally
  // not checked here: it predates the new hierarchy and no production configs are known
  // to use it. findProjectJigReferences still guards it for safe deletion, which
  // means a jig set via the legacy field will block deletion but won't influence
  // resolution. Widen this check if legacy configs ever need to be supported.
  const projectDefault = project?.config?.jigs?.defaultJig;
  if (projectDefault) {
    if (projectDefault === GLOBAL_DEFAULT_JIG_ID || jigs.some((b) => b.id === projectDefault)) {
      return { jigId: projectDefault, source: "project" };
    }
    console.warn(
      `[jig-manager] Configured project default jig '${projectDefault}' not found; falling through to app default`,
    );
  }

  // Tier 2: app-level default from settings.json
  const s = settings ?? loadSettings();
  const appDefault = s.jigs?.defaultJigId;
  if (appDefault) {
    if (appDefault === GLOBAL_DEFAULT_JIG_ID || jigs.some((b) => b.id === appDefault)) {
      return { jigId: appDefault, source: "app" };
    }
    console.warn(
      `[jig-manager] Configured app default jig '${appDefault}' not found; falling through to global default`,
    );
  }

  // Tier 3: embedded global default
  return { jigId: GLOBAL_DEFAULT_JIG_ID, source: "global" };
}

export function getDefaultJigId(projectId: string, settings?: UserPreferences): string {
  return resolveEffectiveDefaultJig(projectId, settings).jigId;
}

export function resolveJigForIssue(
  projectId: string,
  issueType: string | undefined,
  settings?: UserPreferences,
): { jigId: string; source: JigDefaultSource } {
  if (issueType) {
    const project = projectRegistry.getProject(projectId);
    // Note: legacy field project.jigSettings.issueTypeMappings is intentionally not
    // checked here (same rationale as resolveEffectiveDefaultJig: no production configs
    // are known to use it). findProjectJigReferences still guards it for safe deletion.
    const mapped = project?.config?.jigs?.issueTypeMappings?.[issueType];
    if (mapped) {
      if (mapped === GLOBAL_DEFAULT_JIG_ID) {
        return { jigId: mapped, source: "issue-type-mapping" };
      }
      const jigs = listJigsForProject(projectId);
      if (jigs.some((b) => b.id === mapped)) {
        return { jigId: mapped, source: "issue-type-mapping" };
      }
      console.warn(
        `[jig-manager] Mapped jig '${mapped}' for issue type '${issueType}' not found; falling through to default hierarchy`,
      );
    }
  }
  return resolveEffectiveDefaultJig(projectId, settings);
}

export function invalidateCache(projectId?: string): void {
  if (projectId) {
    jigCache.delete(projectId);
  } else {
    jigCache.clear();
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
  const repoDir = getRepoJigsDir(repoPath);

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
    // ENOENT is expected when the repo has no .roubo/jigs/ directory yet.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[jig-manager] Failed to watch ${repoDir}: ${(err as Error).message}`);
    }
  }
}

export function startAppJigsWatcher(): void {
  const projectDir = getAppJigsDir();
  fs.mkdirSync(projectDir, { recursive: true });

  const key = "app-jigs";
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
      console.warn(`[jig-manager] Failed to watch ${projectDir}: ${err.message}`);
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

// ── Jig CRUD: shared types and helpers ──

type JigErrorCode =
  | "NOT_FOUND"
  | "RESERVED_ID"
  | "DUPLICATE_ID"
  | "DUPLICATE_NAME"
  | "INVALID_NAME"
  | "INVALID_DESCRIPTION"
  | "INVALID_ICON"
  | "INVALID_CONTENT"
  | "REFERENCED";

export class JigError extends Error {
  constructor(
    message: string,
    public code: JigErrorCode,
    public data?: JigReference[],
  ) {
    super(message);
    this.name = "JigError";
  }
}

/** Converts a display name to a filesystem-safe slug used as the jig ID. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function writeJigFile(
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
  assertSafeIdentifier(id, JIG_ID_RE, "jigId");
  const resolvedDir = path.resolve(dir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const frontmatter = YAML.stringify(
    { name, description, icon, createdAt, updatedAt },
    { lineWidth: 0 },
  );
  const body = `---\n${frontmatter}---\n${content.endsWith("\n") ? content : content + "\n"}`;
  const filePath = resolveWithin(resolvedDir, `${id}.md`);
  fs.writeFileSync(filePath, body, "utf-8");
  return fs.statSync(filePath).size;
}

function validateJigFields(
  fields: { name?: string; description?: string; icon?: string; content?: string },
  context: "create" | "update",
): void {
  if (context === "create" || fields.name !== undefined) {
    if (typeof fields.name !== "string" || fields.name.trim().length === 0) {
      throw new JigError("name is required", "INVALID_NAME");
    }
    if (fields.name.trim().length > 100) {
      throw new JigError("name must be 100 characters or fewer", "INVALID_NAME");
    }
  }
  if (context === "create" || fields.description !== undefined) {
    if (typeof fields.description !== "string" || fields.description.trim().length === 0) {
      throw new JigError("description is required", "INVALID_DESCRIPTION");
    }
    if (fields.description.trim().length > 300) {
      throw new JigError("description must be 300 characters or fewer", "INVALID_DESCRIPTION");
    }
  }
  if (fields.icon !== undefined) {
    if (typeof fields.icon !== "string" || fields.icon.trim().length === 0) {
      throw new JigError("icon must be a non-empty string", "INVALID_ICON");
    }
  }
  if (context === "create" || fields.content !== undefined) {
    if (typeof fields.content !== "string" || fields.content.trim().length === 0) {
      throw new JigError("content is required", "INVALID_CONTENT");
    }
    if (Buffer.byteLength(fields.content, "utf-8") > HARD_SIZE_LIMIT) {
      throw new JigError(
        `content exceeds the maximum size of ${HARD_SIZE_LIMIT / 1024} KB`,
        "INVALID_CONTENT",
      );
    }
  }
}

// ── Scope-agnostic internal helpers ──
// These take an explicit `dir` and `source` so both app-scope and project-scope
// wrappers can share identical validation, dup-check, and write logic.

function _createJigInDir(dir: string, source: JigSource, req: JigCreateRequest): JigDetail {
  validateJigFields(req, "create");

  const id = slugify(req.name.trim());
  if (!id)
    throw new JigError("name produces an empty slug: use alphanumeric characters", "INVALID_NAME");
  if (id === GLOBAL_DEFAULT_JIG_ID || id === "default")
    throw new JigError(`'${id}' is a reserved jig id`, "RESERVED_ID");

  // Dup checks are scoped to `dir` only: a project jig CAN share an id
  // with an app jig (the project layer overrides at lookup time).
  const existing = loadJigsFromDir(dir, source);
  if (existing.has(id)) {
    throw new JigError(`A jig with id '${id}' already exists`, "DUPLICATE_ID");
  }
  const nameLower = req.name.trim().toLowerCase();
  for (const bp of existing.values()) {
    if (bp.name.toLowerCase() === nameLower) {
      throw new JigError(`A jig named '${bp.name}' already exists`, "DUPLICATE_NAME");
    }
  }

  const icon = req.icon?.trim() || "file-text";
  const name = req.name.trim();
  const description = req.description.trim();
  const { content } = req;
  const now = new Date().toISOString();
  const sizeBytes = writeJigFile(
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

function _updateJigInDir(
  dir: string,
  source: JigSource,
  id: string,
  req: JigUpdateRequest,
): JigDetail {
  if (id === GLOBAL_DEFAULT_JIG_ID) {
    throw new JigError("The built-in default jig cannot be modified", "RESERVED_ID");
  }

  assertSafeIdentifier(id, JIG_ID_RE, "jigId");
  const filePath = resolveWithin(dir, `${id}.md`);
  const existing = loadJigFile(filePath);
  if (!existing) throw new JigError(`Jig '${id}' not found`, "NOT_FOUND");

  validateJigFields(req, "update");

  if (req.name !== undefined) {
    const nameLower = req.name.trim().toLowerCase();
    if (nameLower !== existing.name.toLowerCase()) {
      for (const bp of loadJigsFromDir(dir, source).values()) {
        if (bp.id !== id && bp.name.toLowerCase() === nameLower) {
          throw new JigError(`A jig named '${bp.name}' already exists`, "DUPLICATE_NAME");
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
  const sizeBytes = writeJigFile(
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

function _deleteJigInDir(dir: string, id: string, references: JigReference[]): void {
  if (id === GLOBAL_DEFAULT_JIG_ID) {
    throw new JigError("The built-in default jig cannot be deleted", "RESERVED_ID");
  }

  assertSafeIdentifier(id, JIG_ID_RE, "jigId");
  const filePath = resolveWithin(dir, `${id}.md`);
  if (!fs.existsSync(filePath)) {
    throw new JigError(`Jig '${id}' not found`, "NOT_FOUND");
  }

  if (references.length > 0) {
    throw new JigError("Jig is still referenced and cannot be deleted", "REFERENCED", references);
  }

  fs.unlinkSync(filePath);
}

// ── App-level jig CRUD ──

export function createAppJig(req: JigCreateRequest): JigDetail {
  const detail = _createJigInDir(getAppJigsDir(), "app", req);
  invalidateCache();
  return detail;
}

export function updateAppJig(id: string, req: JigUpdateRequest): JigDetail {
  const detail = _updateJigInDir(getAppJigsDir(), "app", id, req);
  invalidateCache();
  return detail;
}

export function deleteAppJig(id: string): void {
  const refs = findAppJigReferences(id);
  _deleteJigInDir(getAppJigsDir(), id, refs);
  invalidateCache();
}

/** Returns a jig by id from app scope, or null if not found. */
export function getAppJig(id: string): JigDetail | null {
  if (id === GLOBAL_DEFAULT_JIG_ID) return cloneGlobalDefault();

  assertSafeIdentifier(id, JIG_ID_RE, "jigId");
  const filePath = resolveWithin(getAppJigsDir(), `${id}.md`);
  const detail = loadJigFile(filePath);
  if (detail) detail.source = "app";
  return detail;
}

/** Finds all references to an app-level jig across all projects and the user-global setting. */
export function findAppJigReferences(id: string): JigReference[] {
  const refs: JigReference[] = [];

  const settings = loadSettings();
  if (settings.jigs?.defaultJigId === id) {
    refs.push({ type: "app-default" });
  }

  for (const project of projectRegistry.getProjects()) {
    let pushedProjectDefault = false;

    if (project.config?.jigs?.defaultJig === id) {
      refs.push({
        type: "project-default",
        projectId: project.id,
        projectName: project.config.project.displayName,
      });
      pushedProjectDefault = true;
    }

    if (!pushedProjectDefault && project.config?.project?.jigSettings?.defaultJigId === id) {
      refs.push({
        type: "project-default",
        projectId: project.id,
        projectName: project.config.project.displayName,
      });
    }

    const topLevelMappings = project.config?.jigs?.issueTypeMappings;
    const legacyMappings = project.config?.project?.jigSettings?.issueTypeMappings;
    const projectName = project.config?.project.displayName ?? project.id;
    for (const mappings of [topLevelMappings, legacyMappings]) {
      if (mappings) {
        for (const [issueType, jigId] of Object.entries(mappings)) {
          if (jigId === id) {
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

// ── Project-level jig CRUD ──

export function createProjectJig(projectId: string, req: JigCreateRequest): JigDetail {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new JigError(`Project '${projectId}' not found`, "NOT_FOUND");
  const detail = _createJigInDir(getRepoJigsDir(project.repoPath), "project", req);
  invalidateCache(projectId);
  return detail;
}

export function updateProjectJig(projectId: string, id: string, req: JigUpdateRequest): JigDetail {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new JigError(`Project '${projectId}' not found`, "NOT_FOUND");
  const detail = _updateJigInDir(getRepoJigsDir(project.repoPath), "project", id, req);
  invalidateCache(projectId);
  return detail;
}

export function deleteProjectJig(projectId: string, id: string): void {
  const project = projectRegistry.getProject(projectId);
  if (!project) throw new JigError(`Project '${projectId}' not found`, "NOT_FOUND");
  const refs = findProjectJigReferences(projectId, id);
  _deleteJigInDir(getRepoJigsDir(project.repoPath), id, refs);
  invalidateCache(projectId);
}

/** Returns a jig by id from project scope only, or null if not found. */
export function getProjectJig(projectId: string, id: string): JigDetail | null {
  if (id === GLOBAL_DEFAULT_JIG_ID) return null; // reserved id never lives in a repo

  const project = projectRegistry.getProject(projectId);
  if (!project) return null;

  assertSafeIdentifier(id, JIG_ID_RE, "jigId");
  const filePath = resolveWithin(getRepoJigsDir(project.repoPath), `${id}.md`);
  const detail = loadJigFile(filePath);
  if (detail) detail.source = "project";
  return detail;
}

/** Finds references to a project-level jig within that project's own roubo.yaml. */
export function findProjectJigReferences(projectId: string, id: string): JigReference[] {
  const refs: JigReference[] = [];
  const project = projectRegistry.getProject(projectId);
  if (!project) return refs;

  const projectName = project.config?.project.displayName ?? project.id;
  let pushedProjectDefault = false;

  if (project.config?.jigs?.defaultJig === id) {
    refs.push({ type: "project-default", projectId, projectName });
    pushedProjectDefault = true;
  }

  if (!pushedProjectDefault && project.config?.project?.jigSettings?.defaultJigId === id) {
    refs.push({ type: "project-default", projectId, projectName });
  }

  const topLevelMappings = project.config?.jigs?.issueTypeMappings;
  const legacyMappings = project.config?.project?.jigSettings?.issueTypeMappings;
  for (const mappings of [topLevelMappings, legacyMappings]) {
    if (mappings) {
      for (const [issueType, jigId] of Object.entries(mappings)) {
        if (jigId === id) {
          refs.push({ type: "issue-type-mapping", projectId, projectName, issueType });
        }
      }
    }
  }

  return refs;
}
