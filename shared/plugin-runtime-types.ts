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
}
