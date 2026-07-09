import type { ConfiguredSource, FilterFacet, FilterFacetOption } from "@roubo/plugin-sdk";
import { z } from "zod";
import * as pluginManager from "./plugin-manager.js";

const RPC_TIMEOUT_MS = 5_000;

/**
 * Host-side shape guard for a single `filterFacets` descriptor, mirroring the
 * `FilterFacet` interface (shared/types.ts). A plugin is untrusted: it may
 * return a descriptor that is missing `label`/`type` or otherwise the wrong
 * shape. `getPluginFilterFacets` validates each entry against this schema and
 * drops the ones that fail (FR-065, TC-190) so malformed descriptors never
 * reach the client. Unknown extra keys are tolerated (not `.strict()`) so a
 * plugin adding a field it understands is not spuriously dropped.
 */
const FilterFacetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["enum", "enum-async", "multi-enum"]),
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
      }),
    )
    .optional(),
});

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
 * FR-065). Returns the plugin's facet descriptors after dropping any that fail
 * host-side validation (a plugin is untrusted; malformed entries must never
 * reach the client), or the fixed common-facet set when the plugin omits the
 * method. Any other failure (transport, plugin error) is re-thrown for the
 * caller to surface.
 */
export async function getPluginFilterFacets(pluginId: string): Promise<FilterFacet[]> {
  let resolved: FilterFacet[];
  try {
    resolved = await pluginManager.invoke<FilterFacet[]>(pluginId, "filterFacets", undefined, {
      timeoutMs: RPC_TIMEOUT_MS,
    });
  } catch (err) {
    if (isMethodNotFound(err)) {
      return COMMON_FACET_FALLBACK.map((f) => ({ ...f }));
    }
    throw err;
  }

  // A plugin is untrusted: the `FilterFacet[]` type is only a compile-time cast,
  // so guard the container shape before per-entry validation. A non-array
  // response (null, an object, etc.) is dropped wholesale rather than crashing
  // on `.filter`, so malformed output never reaches the client (FR-065).
  if (!Array.isArray(resolved)) {
    console.warn(
      `[plugin-filter-facets] Ignored non-array filterFacets response from plugin "${pluginId}": ${JSON.stringify(resolved)}`,
    );
    return [];
  }

  return resolved.filter((facet) => {
    if (FilterFacetSchema.safeParse(facet).success) return true;
    console.warn(
      `[plugin-filter-facets] Dropped malformed filterFacets descriptor from plugin "${pluginId}": ${JSON.stringify(facet)}`,
    );
    return false;
  });
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
