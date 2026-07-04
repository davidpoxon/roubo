import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./plugin-manager.js", () => ({ invoke: vi.fn() }));

import { getPluginSortFields } from "./plugin-sort-fields.js";
import * as pluginManager from "./plugin-manager.js";

const PLUGIN_ID = "github-com";

function methodNotFound(method: string): Error & { code: string } {
  const err = new Error(`Method not found: ${method}`) as Error & { code: string };
  err.code = "MethodNotFound";
  return err;
}

let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(pluginManager.invoke).mockReset();
  // The degrade-to-default path (CLI-NFR-009) intentionally calls console.info;
  // spy on it so the assertions can verify the log and no output leaks to stdout.
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  infoSpy.mockRestore();
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
    // The success path is not a degradation, so it logs nothing.
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("returns [] on MethodNotFound so the host renders no picker (CLI-FR-011)", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(methodNotFound("getSortFields"));

    const result = await getPluginSortFields(PLUGIN_ID);

    expect(result).toEqual([]);
  });

  it("logs a structured degradation event on MethodNotFound (CLI-NFR-009)", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(methodNotFound("getSortFields"));

    await getPluginSortFields(PLUGIN_ID);

    expect(infoSpy).toHaveBeenCalledExactlyOnceWith(
      `[cut-list-sort] degrade getSortFields-unsupported plugin=${PLUGIN_ID}`,
    );
    // No secret material in the degradation line.
    const line = String(infoSpy.mock.calls[0][0]);
    expect(line).not.toMatch(/token|secret|credential|password/i);
  });

  it("re-throws non-MethodNotFound errors without logging a degradation event", async () => {
    const transportErr = new Error("connection reset") as Error & { code: string };
    transportErr.code = "rpc-error";
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(transportErr);

    await expect(getPluginSortFields(PLUGIN_ID)).rejects.toThrow("connection reset");
    // A transport/plugin error is re-thrown, not a degrade-to-default, so no log.
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
