import type { ConfiguredSource, FilterFacet, FilterFacetOption } from "@roubo/plugin-sdk";
import * as pluginManager from "./plugin-manager.js";

const RPC_TIMEOUT_MS = 5_000;

/**
 * The fixed common-facet set returned when a plugin built against
 * host-API 1.0.0 omits `filterFacets` and the RPC resolves with
 * `MethodNotFound`. Per FR-065 / TC-126, core never surfaces
 * `MethodNotFound` to the UI; the cut list always sees at least these
 * four dropdowns.
 */
export const COMMON_FACET_FALLBACK: readonly FilterFacet[] = Object.freeze([
  { id: "status", label: "Status", type: "enum" },
  { id: "label", label: "Label", type: "enum" },
  { id: "assignee", label: "Assignee", type: "enum" },
  { id: "type", label: "Type", type: "enum" },
]);

/**
 * Host-side wrapper around the plugin's `filterFacets` RPC (host-API 1.1.0+,
 * FR-065). Returns the plugin's facet descriptors verbatim, or the fixed
 * common-facet set when the plugin omits the method. Any other failure
 * (transport, plugin error) is re-thrown for the caller to surface.
 */
export async function getPluginFilterFacets(pluginId: string): Promise<FilterFacet[]> {
  try {
    return await pluginManager.invoke<FilterFacet[]>(pluginId, "filterFacets", undefined, {
      timeoutMs: RPC_TIMEOUT_MS,
    });
  } catch (err) {
    if (isMethodNotFound(err)) {
      return COMMON_FACET_FALLBACK.map((f) => ({ ...f }));
    }
    throw err;
  }
}

/**
 * Host-side wrapper around the plugin's `getFacetOptions` RPC (host-API
 * 1.1.0+, FR-065). Plugins built against 1.0.0, or plugins that omit the
 * method, resolve to an empty option list rather than surfacing
 * `MethodNotFound`; the UI presents an empty dropdown in that case.
 */
export async function getPluginFacetOptions(
  pluginId: string,
  params: { facetId: string; sources: ConfiguredSource[]; search?: string },
): Promise<FilterFacetOption[]> {
  try {
    return await pluginManager.invoke<FilterFacetOption[]>(pluginId, "getFacetOptions", params, {
      timeoutMs: RPC_TIMEOUT_MS,
    });
  } catch (err) {
    if (isMethodNotFound(err)) return [];
    throw err;
  }
}

function isMethodNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code === "MethodNotFound";
}
