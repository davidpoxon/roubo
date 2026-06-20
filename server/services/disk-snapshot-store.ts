import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ConfiguredSource, ListIssuesParams, PaginatedIssues } from "@roubo/shared";
import { atomicWrite, getRouboDir } from "./state.js";
import { PROJECT_ID_RE } from "../lib/safe-path.js";

// Persistent, on-disk first-page issue snapshot cache (CLI-FR-001, CLI-FR-003,
// CLI-NFR-001). This is the first place private GHE/Jira issue content (titles,
// bodies, assignees) is written to local disk, so every entry is written 0600
// and carries no credential/token material (those stay in the OS keyring via
// `credential-store.ts`). The cache key composes the frozen twelve-field
// Spike-553 contract; see `spike-553-cache-key-invalidation-lifecycle.md`.
//
// The store is hand-rolled JSON over Node's built-in `crypto`: no new runtime
// dependency. It deliberately diverges from the in-memory
// `issue-snapshot-cache.ts` (which keeps a warm snapshot on plugin disable for
// the errored-fallback serve path); the in-memory cache is unchanged and still
// owns that fallback. This store evicts on the lifecycle events instead, though
// wiring those events is a later slice (the methods are exposed here).

/**
 * Current on-disk schema version (Spike-553 field 12). Bump by exactly one when
 * a change would make a previously written file mis-parse or carry stale-shaped
 * data under new code: the DiskCacheEntry envelope shape changes, the
 * canonicalisation rule for any keyed field changes, or the cached
 * `PaginatedIssues` payload shape changes in a way the reader cannot tolerate.
 * A stored value older than this is a cold miss on read.
 */
export const CACHE_SCHEMA_VERSION = 1;

/** Per-entry serialised-size cap. Over-cap entries are skipped, never persisted. */
export const PER_ENTRY_MAX_BYTES = 1024 * 1024; // 1 MB
/** Total cache-directory size bound, enforced by LRU (file mtime) on `put`. */
export const TOTAL_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
/** Maximum entry age from `capturedAt`. Older entries are a cold miss on read. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * The frozen twelve-field cache key (Spike-553 AC1). Fields are declared and
 * serialised in this exact order; key-insertion order is never relied upon.
 */
export interface CacheKey {
  pluginId: string;
  pluginVersion: string;
  /** SHA-256 of the normalised instance endpoint; never the raw endpoint, never a credential. */
  instanceHash: string;
  projectId: string;
  sources: ConfiguredSource[];
  filters: { labels?: string[]; search?: string } | null;
  excludedStatusCategories: string[];
  excludedStatuses: string[];
  sortBy: string | null;
  sortDir: "asc" | "desc" | null;
  pageSize: number;
  cacheSchemaVersion: number;
}

/**
 * The on-disk entry envelope. Carries issue content only (`response`): no
 * credentials or tokens. `cacheSchemaVersion` and `pluginVersion` are stored
 * here as a defensive second guard: a file that survives a key bump but happens
 * to collide on filename is still rejected on read.
 */
export interface DiskCacheEntry {
  cacheSchemaVersion: number;
  cacheKeyHash: string;
  capturedAt: string;
  /**
   * The owning pluginId. Not part of the Spike-553 *key* (the key hashes the
   * pluginId into the filename), but persisted in the envelope so `evictPlugin`
   * can select entries by plugin without re-deriving the key. It is plugin
   * identity, never a credential.
   */
  pluginId: string;
  pluginVersion: string;
  response: PaginatedIssues;
}

/** Inputs that determine a first-page query, before canonicalisation. */
export interface CacheKeyInput {
  pluginId: string;
  pluginVersion: string;
  /** The normalised instance endpoint (or null/empty for fixed-host plugins like github.com). */
  instanceEndpoint: string | null;
  projectId: string;
  sources: ConfiguredSource[];
  filters: ListIssuesParams["filters"];
  excludedStatusCategories: string[];
  excludedStatuses: string[];
  sortBy: string | null;
  sortDir: "asc" | "desc" | null;
  pageSize: number;
}

/** Reasons a stored file is discarded on read, surfaced (without secrets) to the discard log. */
export type DiscardReason =
  | "missing"
  | "corrupt"
  | "schema-version-mismatch"
  | "plugin-version-mismatch"
  | "over-age";

/** Reasons a `put` does not persist, surfaced to the discard log. */
export type SkipReason = "over-entry-cap";

export interface DiscardLogEvent {
  trigger:
    | DiscardReason
    | SkipReason
    | "lru-evicted"
    | "age-swept"
    | "plugin-evicted"
    | "project-evicted";
  /** The owning plugin when known; "unknown" for sweeps that could not read the entry. */
  pluginId: string;
  projectId: string;
}

/**
 * Normalise an instance endpoint into the canonical form hashed into
 * `instanceHash`: lowercased host, scheme included, a single normalised
 * trailing slash dropped. A fixed-host plugin (e.g. github.com) has no
 * configured instance; its canonical empty form is the literal empty string,
 * so every github.com project shares one stable `instanceHash`.
 */
export function normalizeInstanceEndpoint(endpoint: string | null | undefined): string {
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) return "";
  const trimmed = endpoint.trim();
  try {
    const url = new URL(trimmed);
    const scheme = url.protocol.toLowerCase();
    const host = url.host.toLowerCase();
    // Normalise the path: drop a lone trailing slash so `https://h/` and
    // `https://h` collapse to the same instance.
    let pathname = url.pathname;
    if (pathname === "/") pathname = "";
    else if (pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return `${scheme}//${host}${pathname}`;
  } catch {
    // Not a parseable URL: fall back to a lowercased, trailing-slash-normalised
    // string so a bare host still produces a stable, comparable value.
    let s = trimmed.toLowerCase();
    while (s.endsWith("/")) s = s.slice(0, -1);
    return s;
  }
}

/** SHA-256 hex of the normalised instance endpoint (the `instanceHash` field). */
export function hashInstanceEndpoint(endpoint: string | null | undefined): string {
  return crypto
    .createHash("sha256")
    .update(normalizeInstanceEndpoint(endpoint), "utf-8")
    .digest("hex");
}

/** Canonical-sort a ConfiguredSource[] so reordering alone does not change the key. */
function canonicalSources(sources: ConfiguredSource[]): ConfiguredSource[] {
  return [...sources]
    .map((s) => {
      // Emit keys in a fixed order, omitting undefined fields, so two logically
      // equal sources serialise identically regardless of object construction.
      const out: Record<string, unknown> = { kind: s.kind, externalId: s.externalId };
      if (s.project !== undefined) out.project = s.project;
      if (s.boardMode !== undefined) out.boardMode = s.boardMode;
      if (s.mineScope !== undefined) out.mineScope = s.mineScope;
      if (s.includeCodeQLAlerts !== undefined) out.includeCodeQLAlerts = s.includeCodeQLAlerts;
      if (s.includeSecretScanningAlerts !== undefined)
        out.includeSecretScanningAlerts = s.includeSecretScanningAlerts;
      if (s.includeDependabotAlerts !== undefined)
        out.includeDependabotAlerts = s.includeDependabotAlerts;
      return out as unknown as ConfiguredSource;
    })
    .sort((a, b) => {
      const ka = JSON.stringify(a);
      const kb = JSON.stringify(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}

/** Sort ascending and de-duplicate a string list (used for labels / excluded* fields). */
function sortedUnique(values: string[] | undefined): string[] {
  if (!values || values.length === 0) return [];
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Canonicalise `filters`: labels sorted+deduped, search trimmed, absent collapses to null. */
function canonicalFilters(
  filters: ListIssuesParams["filters"],
): { labels?: string[]; search?: string } | null {
  if (!filters) return null;
  const out: { labels?: string[]; search?: string } = {};
  const labels = sortedUnique(filters.labels);
  if (labels.length > 0) out.labels = labels;
  const search = typeof filters.search === "string" ? filters.search.trim() : "";
  if (search.length > 0) out.search = search;
  // Present-but-empty collapses to null so it hashes identically to absent.
  return Object.keys(out).length > 0 ? out : null;
}

/** Build the canonical CacheKey object from raw query inputs. */
export function buildCacheKey(input: CacheKeyInput): CacheKey {
  return {
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    instanceHash: hashInstanceEndpoint(input.instanceEndpoint),
    projectId: input.projectId,
    sources: canonicalSources(input.sources),
    filters: canonicalFilters(input.filters),
    excludedStatusCategories: sortedUnique(input.excludedStatusCategories),
    excludedStatuses: sortedUnique(input.excludedStatuses),
    sortBy: input.sortBy ?? null,
    sortDir: input.sortDir ?? null,
    pageSize: input.pageSize,
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
  };
}

/**
 * Serialise a CacheKey by emitting every field in fixed declaration order
 * (never object key-insertion order), then SHA-256 it. The hex digest is the
 * per-project filename stem.
 */
export function hashCacheKey(key: CacheKey): string {
  // Build the canonical string field-by-field in the frozen order. The inner
  // objects/arrays are already canonicalised by `buildCacheKey`, so JSON of
  // each is stable.
  const ordered: Array<[string, unknown]> = [
    ["pluginId", key.pluginId],
    ["pluginVersion", key.pluginVersion],
    ["instanceHash", key.instanceHash],
    ["projectId", key.projectId],
    ["sources", key.sources],
    ["filters", key.filters],
    ["excludedStatusCategories", key.excludedStatusCategories],
    ["excludedStatuses", key.excludedStatuses],
    ["sortBy", key.sortBy],
    ["sortDir", key.sortDir],
    ["pageSize", key.pageSize],
    ["cacheSchemaVersion", key.cacheSchemaVersion],
  ];
  const serialised = ordered.map(([k, v]) => `${k}=${JSON.stringify(v ?? null)}`).join("\n");
  return crypto.createHash("sha256").update(serialised, "utf-8").digest("hex");
}

/**
 * Internal helper so a sanitised projectId is the only thing that ever reaches
 * a filesystem path segment. A projectId failing `PROJECT_ID_RE` cannot name a
 * directory; rather than throw on the hot path, callers treat that as a cache
 * bypass (return null / skip put).
 */
function isSafeProjectId(projectId: string): boolean {
  return PROJECT_ID_RE.test(projectId);
}

/**
 * The persistent first-page snapshot store. Accepts an explicit `baseDir`
 * (used by tests to point at a temp directory); production callers omit it and
 * the cache lives under `~/.roubo/issue-snapshots/`.
 */
export class DiskSnapshotStore {
  private readonly baseDir: string;
  private readonly onDiscard?: (event: DiscardLogEvent) => void;
  /** Total-directory size bound (LRU-enforced). Overridable for tests. */
  private readonly totalMaxBytes: number;

  constructor(opts?: {
    baseDir?: string;
    onDiscard?: (event: DiscardLogEvent) => void;
    totalMaxBytes?: number;
  }) {
    this.baseDir = opts?.baseDir ?? path.join(getRouboDir(), "issue-snapshots");
    this.onDiscard = opts?.onDiscard;
    this.totalMaxBytes = opts?.totalMaxBytes ?? TOTAL_MAX_BYTES;
  }

  private emit(event: DiscardLogEvent): void {
    this.onDiscard?.(event);
  }

  private projectDir(projectId: string): string {
    return path.join(this.baseDir, projectId);
  }

  private entryPath(projectId: string, hash: string): string {
    return path.join(this.projectDir(projectId), `${hash}.json`);
  }

  /**
   * Read the entry for `key`, or null on any miss. A miss is: no file, a
   * corrupt / partial / truncated / invalid-UTF-8 file, a stored
   * cacheSchemaVersion or pluginVersion mismatch, or an entry older than
   * MAX_AGE_MS. Never throws, never fatal: every read is wrapped so a bad file
   * is a cold miss, not a startup error.
   */
  get(key: CacheKey): DiskCacheEntry | null {
    const { projectId, pluginId } = key;
    if (!isSafeProjectId(projectId)) return null;
    const hash = hashCacheKey(key);
    const file = this.entryPath(projectId, hash);

    let raw: string;
    try {
      raw = fs.readFileSync(file, { encoding: "utf-8" });
    } catch {
      // No file (or unreadable): a plain miss. Not a discard worth logging.
      return null;
    }

    let entry: DiskCacheEntry;
    try {
      const parsed = JSON.parse(raw) as DiskCacheEntry;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.cacheSchemaVersion !== "number" ||
        typeof parsed.pluginVersion !== "string" ||
        typeof parsed.capturedAt !== "string" ||
        typeof parsed.response !== "object" ||
        parsed.response === null
      ) {
        throw new Error("malformed entry");
      }
      entry = parsed;
    } catch {
      this.emit({ trigger: "corrupt", pluginId, projectId });
      this.unlinkQuiet(file);
      return null;
    }

    if (entry.cacheSchemaVersion !== key.cacheSchemaVersion) {
      this.emit({ trigger: "schema-version-mismatch", pluginId, projectId });
      this.unlinkQuiet(file);
      return null;
    }
    if (entry.pluginVersion !== key.pluginVersion) {
      this.emit({ trigger: "plugin-version-mismatch", pluginId, projectId });
      this.unlinkQuiet(file);
      return null;
    }

    const capturedMs = Date.parse(entry.capturedAt);
    if (!Number.isFinite(capturedMs) || Date.now() - capturedMs > MAX_AGE_MS) {
      this.emit({ trigger: "over-age", pluginId, projectId });
      this.unlinkQuiet(file);
      return null;
    }

    // Refresh the file mtime on a read hit so the total-bound eviction in
    // `enforceTotalBound` is genuinely LRU (by access recency), not FIFO (by
    // write time). Best-effort: a failed touch must never turn a valid hit into
    // a miss, so swallow any error and still serve the entry.
    this.touchQuiet(file);
    return entry;
  }

  /**
   * Persist the first-page response for `key`. Eviction is opportunistic on
   * write: sweep aged-out entries, enforce the 50 MB total bound by LRU, then
   * skip (and log) if the serialised entry exceeds the per-entry cap. A skip
   * degrades to a cold load on the next read, never an error.
   */
  put(key: CacheKey, response: PaginatedIssues): void {
    const { projectId, pluginId } = key;
    if (!isSafeProjectId(projectId)) return;
    const hash = hashCacheKey(key);
    const entry: DiskCacheEntry = {
      cacheSchemaVersion: key.cacheSchemaVersion,
      cacheKeyHash: hash,
      capturedAt: new Date().toISOString(),
      pluginId,
      pluginVersion: key.pluginVersion,
      response,
    };
    const data = JSON.stringify(entry);
    const size = Buffer.byteLength(data, "utf-8");

    if (size > PER_ENTRY_MAX_BYTES) {
      this.emit({ trigger: "over-entry-cap", pluginId, projectId });
      return;
    }

    this.ensureBaseDirs(projectId);
    this.sweepAged();
    this.enforceTotalBound(size);
    this.writeEntry(this.entryPath(projectId, hash), data);
  }

  /** Single private helper that hard-codes the 0600 file mode (CLI-NFR-001). */
  private writeEntry(filePath: string, data: string): void {
    atomicWrite(filePath, data, 0o600);
  }

  private ensureBaseDirs(projectId: string): void {
    fs.mkdirSync(this.projectDir(projectId), { recursive: true });
  }

  /** Remove a file, swallowing any error (a failed unlink must never be fatal). */
  private unlinkQuiet(file: string): void {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }

  /**
   * Refresh a file's access + modification time to now, swallowing any error.
   * Used on a read hit so total-bound eviction orders by access recency (LRU),
   * not write time (FIFO). A failed touch must never break the read.
   */
  private touchQuiet(file: string): void {
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
    } catch {
      // Best-effort recency refresh only.
    }
  }

  /** All entry files across all project subdirectories, with size + mtime. */
  private listEntries(): Array<{ file: string; projectId: string; size: number; mtimeMs: number }> {
    const out: Array<{ file: string; projectId: string; size: number; mtimeMs: number }> = [];
    let projects: fs.Dirent[];
    try {
      projects = fs.readdirSync(this.baseDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const dir = path.join(this.baseDir, p.name);
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const file = path.join(dir, f);
        try {
          const stat = fs.statSync(file);
          out.push({ file, projectId: p.name, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // File vanished between readdir and stat: ignore.
        }
      }
    }
    return out;
  }

  /** Discard every entry past MAX_AGE_MS, by `capturedAt`. */
  private sweepAged(): void {
    const now = Date.now();
    for (const e of this.listEntries()) {
      let captured: string | undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(e.file, { encoding: "utf-8" })) as DiskCacheEntry;
        captured = parsed?.capturedAt;
      } catch {
        // Corrupt file: drop it as part of the sweep.
        this.emit({ trigger: "age-swept", pluginId: "unknown", projectId: e.projectId });
        this.unlinkQuiet(e.file);
        continue;
      }
      const capturedMs = captured ? Date.parse(captured) : NaN;
      if (!Number.isFinite(capturedMs) || now - capturedMs > MAX_AGE_MS) {
        this.emit({ trigger: "age-swept", pluginId: "unknown", projectId: e.projectId });
        this.unlinkQuiet(e.file);
      }
    }
  }

  /** Evict least-recently-used entries (by mtime) until `incomingSize` will fit under the bound. */
  private enforceTotalBound(incomingSize: number): void {
    let entries = this.listEntries();
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total + incomingSize <= this.totalMaxBytes) return;
    // Oldest first by mtime (read hits refresh mtime, so this is LRU).
    entries = entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of entries) {
      if (total + incomingSize <= this.totalMaxBytes) break;
      this.emit({ trigger: "lru-evicted", pluginId: "unknown", projectId: e.projectId });
      this.unlinkQuiet(e.file);
      total -= e.size;
    }
  }

  /**
   * Remove every cached entry for `pluginId` across all projects. Exposed for
   * the lifecycle eviction slice; wiring it to plugin disable/uninstall/version
   * change is out of scope here. Because the filename hashes the pluginId in,
   * we cannot select by name from the path alone, so we read each entry and
   * match on the stored response. Entries are keyed by hash, so this scans:
   * acceptable at single-user scale.
   */
  evictPlugin(pluginId: string): void {
    // The pluginId is hashed into the filename, not exposed in the path, so we
    // match on the `pluginId` field persisted in each entry envelope. Scanning
    // every entry is acceptable at single-user scale.
    for (const e of this.listEntries()) {
      let owner: string | undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(e.file, { encoding: "utf-8" })) as DiskCacheEntry;
        owner = parsed?.pluginId;
      } catch {
        // Corrupt file: leave it for the read-time / sweep discard path.
        continue;
      }
      if (owner === pluginId) {
        this.emit({ trigger: "plugin-evicted", pluginId, projectId: e.projectId });
        this.unlinkQuiet(e.file);
      }
    }
  }

  /**
   * Remove every cached entry for `projectId`: a single directory removal,
   * since each project owns a subdirectory. Exposed for the lifecycle eviction
   * slice; wiring it to project unregister is out of scope here.
   */
  evictProject(projectId: string): void {
    if (!isSafeProjectId(projectId)) return;
    this.emit({ trigger: "project-evicted", pluginId: "unknown", projectId });
    try {
      fs.rmSync(this.projectDir(projectId), { recursive: true, force: true });
    } catch {
      // Best-effort: a missing directory is already "evicted".
    }
  }
}
