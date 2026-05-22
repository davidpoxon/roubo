import type { PluginManifest } from "./plugin-manifest-schema.js";

export type PluginStatus = "enabled" | "disabled" | "errored" | "incompatible" | "invalid";

export type PluginSource = "bundled" | "user";

export interface RestartEvent {
  at: string;
  reason: "unexpected-exit" | "spawn-failed";
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
}
