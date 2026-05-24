import type { SetActiveConfigResult } from "@roubo/plugin-sdk";
import { parseConfig, setActiveConfig } from "../active-config.js";

/**
 * Lightweight activation: shape-check the host-supplied config and cache it
 * as the plugin's active configuration for subsequent source-bound methods
 * (listIssues, listIssueTypes, listLabels). No network calls; this runs on
 * every source-bound RPC so the cost has to stay flat.
 *
 * Separate from validateConfig (which probes /user and every source) because
 * activation is a hot path: the host calls it immediately before each
 * source-bound invocation to push the per-project sources onto a plugin
 * process that may have just started or last seen a different project's
 * config.
 */
export function setActiveConfigMethod(params: {
  config: Record<string, unknown>;
}): SetActiveConfigResult {
  const { config, errors } = parseConfig(params.config);
  if (!config) {
    return { ok: false, errors };
  }
  setActiveConfig(config);
  return { ok: true };
}
