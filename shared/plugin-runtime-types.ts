import type { PluginManifest } from "./plugin-manifest-schema.js";

export type PluginStatus = "enabled" | "disabled" | "errored" | "incompatible" | "invalid";

export type PluginSource = "bundled" | "user";

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
  // ledger simply omits these. Absent means first-party / verified, so no
  // migration is needed.
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
  // means not orphaned. The removal UX that consumes it is a separate slice.
  sourceId?: string;
  sourceUrl?: string;
  unverified?: boolean;
  orphaned?: boolean;
}
