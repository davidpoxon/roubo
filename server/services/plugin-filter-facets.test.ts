import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./plugin-manager.js", () => ({ invoke: vi.fn() }));

import {
  COMMON_FACET_FALLBACK,
  getPluginFacetOptions,
  getPluginFilterFacets,
} from "./plugin-filter-facets.js";
import * as pluginManager from "./plugin-manager.js";

const PLUGIN_ID = "github-com";

function methodNotFound(method: string): Error & { code: string } {
  const err = new Error(`Method not found: ${method}`) as Error & { code: string };
  err.code = "MethodNotFound";
  return err;
}

beforeEach(() => {
  vi.mocked(pluginManager.invoke).mockReset();
});

describe("getPluginFilterFacets", () => {
  it("returns the plugin's descriptors verbatim when filterFacets resolves", async () => {
    const descriptors = [{ id: "milestone", label: "Milestone", type: "enum-async" as const }];
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce(descriptors);

    const result = await getPluginFilterFacets(PLUGIN_ID);

    expect(result).toEqual(descriptors);
    expect(pluginManager.invoke).toHaveBeenCalledExactlyOnceWith(
      PLUGIN_ID,
      "filterFacets",
      undefined,
      { timeoutMs: 5_000 },
    );
  });

  it("returns the fixed common-facet set on MethodNotFound (TC-126)", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(methodNotFound("filterFacets"));

    const result = await getPluginFilterFacets(PLUGIN_ID);

    expect(result).toEqual([
      { id: "status", label: "Status", type: "enum" },
      { id: "label", label: "Label", type: "enum" },
      { id: "assignee", label: "Assignee", type: "enum" },
      { id: "type", label: "Type", type: "enum" },
    ]);
  });

  it("returns a fresh copy each time so callers cannot mutate the fallback constant", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(methodNotFound("filterFacets"));

    const first = await getPluginFilterFacets(PLUGIN_ID);
    first[0].label = "MUTATED";
    const second = await getPluginFilterFacets(PLUGIN_ID);

    expect(second[0].label).toBe("Status");
    expect(COMMON_FACET_FALLBACK[0].label).toBe("Status");
  });

  it("re-throws non-MethodNotFound errors", async () => {
    const transportErr = new Error("connection reset") as Error & { code: string };
    transportErr.code = "rpc-error";
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(transportErr);

    await expect(getPluginFilterFacets(PLUGIN_ID)).rejects.toThrow("connection reset");
  });
});

describe("getPluginFacetOptions", () => {
  it("returns the plugin's options verbatim when getFacetOptions resolves", async () => {
    const options = [
      { value: "v1.0", label: "v1.0" },
      { value: "v1.1", label: "v1.1" },
    ];
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce(options);

    const result = await getPluginFacetOptions(PLUGIN_ID, {
      facetId: "milestone",
      sources: [{ kind: "repo", externalId: "foo/bar" }],
      search: "v1",
    });

    expect(result).toEqual(options);
    expect(pluginManager.invoke).toHaveBeenCalledExactlyOnceWith(
      PLUGIN_ID,
      "getFacetOptions",
      {
        facetId: "milestone",
        sources: [{ kind: "repo", externalId: "foo/bar" }],
        search: "v1",
      },
      { timeoutMs: 5_000 },
    );
  });

  it("returns [] on MethodNotFound so the UI shows an empty dropdown rather than an error", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(methodNotFound("getFacetOptions"));

    const result = await getPluginFacetOptions(PLUGIN_ID, {
      facetId: "milestone",
      sources: [],
    });

    expect(result).toEqual([]);
  });

  it("re-throws non-MethodNotFound errors", async () => {
    const timeoutErr = new Error("timed out") as Error & { code: string };
    timeoutErr.code = "timeout";
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(timeoutErr);

    await expect(
      getPluginFacetOptions(PLUGIN_ID, { facetId: "milestone", sources: [] }),
    ).rejects.toThrow("timed out");
  });
});
