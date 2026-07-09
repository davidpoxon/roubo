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

  it("drops a malformed descriptor host-side while valid siblings pass through (TC-190)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const valid = { id: "milestone", label: "Milestone", type: "enum-async" as const };
    // Missing the required `label` and `type`: malformed, must be dropped.
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce([{ id: "x" }, valid] as never);

    const result = await getPluginFilterFacets(PLUGIN_ID);

    expect(result).toEqual([valid]);
    warn.mockRestore();
  });

  it("logs the drop with the plugin id and the offending entry (TC-190 S002-O03)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const offending = { id: "x" };
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce([offending] as never);

    const result = await getPluginFilterFacets(PLUGIN_ID);

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain(PLUGIN_ID);
    expect(message).toContain(JSON.stringify(offending));
    warn.mockRestore();
  });

  it("also drops descriptors with a wrong-shaped type or empty required strings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const valid = { id: "status", label: "Status", type: "enum" as const };
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce([
      { id: "bad-type", label: "Bad", type: "not-a-facet-type" },
      { id: "", label: "Empty id", type: "enum" },
      valid,
    ] as never);

    const result = await getPluginFilterFacets(PLUGIN_ID);

    expect(result).toEqual([valid]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("returns an all-valid array unchanged and logs nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const descriptors = [
      { id: "status", label: "Status", type: "enum" as const },
      {
        id: "milestone",
        label: "Milestone",
        type: "multi-enum" as const,
        options: [{ value: "v1", label: "v1" }],
      },
    ];
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce(descriptors);

    const result = await getPluginFilterFacets(PLUGIN_ID);

    expect(result).toEqual(descriptors);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops a non-array response wholesale without throwing (untrusted container shape)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The plugin is untrusted: a non-array response must not crash `.filter`.
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce(null as never);

    const result = await getPluginFilterFacets(PLUGIN_ID);

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(PLUGIN_ID);
    warn.mockRestore();
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
