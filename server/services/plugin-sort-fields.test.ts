import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./plugin-manager.js", () => ({ invoke: vi.fn() }));

import { getPluginSortFields } from "./plugin-sort-fields.js";
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

describe("getPluginSortFields", () => {
  it("returns the plugin's sort fields verbatim when getSortFields resolves", async () => {
    const fields = [
      { id: "created", label: "Created", defaultDir: "desc" as const },
      { id: "updated", label: "Updated", defaultDir: "desc" as const },
    ];
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce(fields);

    const result = await getPluginSortFields(PLUGIN_ID);

    expect(result).toEqual(fields);
    expect(pluginManager.invoke).toHaveBeenCalledExactlyOnceWith(
      PLUGIN_ID,
      "getSortFields",
      undefined,
      { timeoutMs: 5_000 },
    );
  });

  it("returns [] on MethodNotFound so the host renders no picker (CLI-FR-011)", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(methodNotFound("getSortFields"));

    const result = await getPluginSortFields(PLUGIN_ID);

    expect(result).toEqual([]);
  });

  it("re-throws non-MethodNotFound errors", async () => {
    const transportErr = new Error("connection reset") as Error & { code: string };
    transportErr.code = "rpc-error";
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(transportErr);

    await expect(getPluginSortFields(PLUGIN_ID)).rejects.toThrow("connection reset");
  });
});
