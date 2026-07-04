import type { SortField } from "@roubo/plugin-sdk";
import * as pluginManager from "./plugin-manager.js";

const RPC_TIMEOUT_MS = 5_000;

/**
 * Host-side wrapper around the plugin's `getSortFields` RPC (host-API 1.2.0+,
 * CLI-FR-009). Returns the plugin's declared sort fields verbatim, or an empty
 * list when the plugin omits the method (resolves with `MethodNotFound`): the
 * host then renders no sort picker, with no error surfaced to the UI
 * (CLI-FR-011). Any other failure (transport, plugin error) is re-thrown for
 * the caller to surface. Mirrors `plugin-filter-facets.ts`.
 */
export async function getPluginSortFields(pluginId: string): Promise<SortField[]> {
  try {
    return await pluginManager.invoke<SortField[]>(pluginId, "getSortFields", undefined, {
      timeoutMs: RPC_TIMEOUT_MS,
    });
  } catch (err) {
    if (isMethodNotFound(err)) {
      // CLI-NFR-009: the degrade-to-default path (the plugin omits getSortFields,
      // so the host renders no picker and falls back to key-ascending order) is a
      // silent-until-now degradation. Emit one structured line carrying only the
      // plugin identity, never issue content or credentials, matching the
      // cut-list cache's `defaultDiscard` log style. The source intentionally
      // logs here, so tests spy + assert on it rather than let it leak to stdout.
      console.info(`[cut-list-sort] degrade getSortFields-unsupported plugin=${pluginId}`);
      return [];
    }
    throw err;
  }
}

function isMethodNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code === "MethodNotFound";
}
