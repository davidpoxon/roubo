import type { PluginManifest } from "./plugin-manifest-schema.js";

export type PluginStatus = "enabled" | "disabled" | "errored" | "incompatible" | "invalid";

export type PluginSource = "bundled" | "user";

/**
 * The default plugins seeded once, offline, on first launch (CPHM-FR-004 /
 * CPHM-US-001). Shared rather than server-local because the client needs it too:
 * a seeded plugin carries no provenance ledger row (the seed install never writes
 * one), so its id is the only thing that distinguishes it from a plugin the user
 * installed from a raw git URL, which likewise has no row. The badge derivation
 * (`recordProvenance`) uses that to read absent provenance as first-party ONLY for
 * these ids and unverified for anything else (CPHMTP-NFR-001, issue #563).
 *
 * The server's seed pass is the authority on the set; this is its single
 * definition, re-exported from `plugin-manager` for the server's own callers.
 */
export const SEED_PLUGIN_IDS = ["github-com", "process", "database"] as const;

export interface RestartEvent {
  at: string;
  reason: "unexpected-exit" | "spawn-failed" | "sandbox-fallback";
  exitCode: number | null;
}

export interface PluginError {
  code: string;
  message: string;
  methodName?: string;
}

export interface LogLine {
  ts: string;
  source: "stdout" | "stderr" | "host";
  level?: "info" | "warn" | "error";
  text: string;
}

/**
 * A structured, user-visible notice that the docker isolation tier could not
 * engage for the plugin's directory. Surfaced on PluginRecord so callers of
 * listInstalled() can present an actionable remediation rather than relying
 * only on the log line (#743).
 */
export interface IsolationNotice {
  kind: "docker-mount-unshared";
  pluginDir: string;
  message: string;
  at: string;
}

export interface PluginRecord {
  id: string;
  manifest: PluginManifest | null;
  manifestPath: string;
  pluginDir: string;
  source: PluginSource;
  status: PluginStatus;
  lastError: PluginError | null;
  restartHistory: RestartEvent[];
  pid: number | null;
  isolationNotices?: IsolationNotice[];
  // Marketplace install provenance (CPHMTP-FR-005 / CPHMTP-FR-006, issue #558).
  // Additive and OPTIONAL: `source` above says only how the plugin reached the
  // machine (bundled with the app vs installed by the user), never WHICH
  // marketplace source served it, and every record predating the provenance
  // ledger simply omits these, so no migration is needed.
  //
  // Absent does NOT mean verified. A first-party seed default carries no ledger
  // row (the seed install writes none), but neither does a plugin installed from
  // a raw git URL or local path, so absence alone cannot be trusted: the UI reads
  // it as first-party only for `SEED_PLUGIN_IDS` above and unverified otherwise
  // (CPHMTP-NFR-001, issue #563). Stamping a row for the seed and raw-install
  // paths, so absence can simply fail closed, is the durable fix
  // (davidpoxon/roubo-development#607).
  //
  // Stamped when a record is rebuilt from disk, read from the provenance ledger
  // (~/.roubo/plugins-provenance.json) that the install commit wrote: the record
  // itself is re-derived from the plugin directory on every load and cannot carry
  // the choice forward on its own.
  //
  // `sourceId` is the marketplace source the consumer explicitly chose at install
  // (`first-party` or a registered source's slug); `sourceUrl` is that source's
  // catalog URL, retained so the record still reads standalone once the source row
  // is removed; `unverified` is true when the chosen source is unsigned. Rendering
  // the persistent unverified badge from these fields across every plugin surface
  // is issue #563.
  //
  // `orphaned` is true once the source this plugin was installed from has been
  // removed from the registry (issue #560). It is stamped onto the ledger at
  // removal time rather than recomputed here by joining against the source
  // registry, so the plugin keeps reading as orphaned across restarts. Absent
  // means not orphaned. The removal UX that consumes it is issue #564.
  sourceId?: string;
  sourceUrl?: string;
  unverified?: boolean;
  orphaned?: boolean;
}
