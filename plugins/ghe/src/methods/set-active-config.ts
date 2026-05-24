import type { SetActiveConfigResult } from "@roubo/plugin-sdk";
import { parseConfig, setActiveConfig } from "../active-config.js";

/**
 * Receive the plugin-wide config (instance URL, allowSelfSignedTls) from the
 * host. This conveys plugin-process-global state only; it is identical
 * across every project using the GHE plugin, so there is no cross-project
 * bleed risk.
 *
 * Source selection is supplied per-call via each source-bound method's
 * `sources` param and is never stored in the active config.
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
