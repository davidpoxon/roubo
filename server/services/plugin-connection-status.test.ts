import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./plugin-manager.js", () => ({ invoke: vi.fn() }));

import { getConnectionStatus } from "./plugin-connection-status.js";
import * as pluginManager from "./plugin-manager.js";

const PLUGIN_ID = "github-com";
const CONFIG = { instance: "https://api.github.com" };
const FROZEN_TIME = new Date("2026-05-25T12:00:00.000Z");

function methodNotFound(method: string): Error & { code: string } {
  const err = new Error(`Method not found: ${method}`) as Error & { code: string };
  err.code = "MethodNotFound";
  return err;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_TIME);
  vi.mocked(pluginManager.invoke).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getConnectionStatus", () => {
  it("returns the plugin's reported status when getConnectionStatus is implemented", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValueOnce({
      state: "connected",
      checkedAt: "2026-05-25T11:59:59.000Z",
    });

    const status = await getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({ state: "connected", checkedAt: "2026-05-25T11:59:59.000Z" });
    expect(pluginManager.invoke).toHaveBeenCalledExactlyOnceWith(
      PLUGIN_ID,
      "getConnectionStatus",
      undefined,
      { timeoutMs: 5_000 },
    );
  });

  it("falls back to validateConfig and reports connected when ok (TC-113)", async () => {
    vi.mocked(pluginManager.invoke)
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockResolvedValueOnce({ ok: true });

    const status = await getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });
    expect(pluginManager.invoke).toHaveBeenNthCalledWith(
      2,
      PLUGIN_ID,
      "validateConfig",
      { config: CONFIG },
      { timeoutMs: 5_000 },
    );
  });

  it("falls back to validateConfig and reports auth-problem with detail when not ok", async () => {
    vi.mocked(pluginManager.invoke)
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockResolvedValueOnce({
        ok: false,
        errors: [{ field: "token", message: "Token expired" }],
      });

    const status = await getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({
      state: "auth-problem",
      detail: "Token expired",
      checkedAt: FROZEN_TIME.toISOString(),
    });
  });

  it("reports auth-problem with undefined detail when validateConfig returns no errors array", async () => {
    vi.mocked(pluginManager.invoke)
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockResolvedValueOnce({ ok: false });

    const status = await getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({
      state: "auth-problem",
      detail: undefined,
      checkedAt: FROZEN_TIME.toISOString(),
    });
  });

  it("treats both methods missing as connected (no plugin-wide config to validate)", async () => {
    vi.mocked(pluginManager.invoke)
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockRejectedValueOnce(methodNotFound("validateConfig"));

    const status = await getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({ state: "connected", checkedAt: FROZEN_TIME.toISOString() });
  });

  it("reports errored when validateConfig throws a non-MethodNotFound error", async () => {
    const boom = Object.assign(new Error("upstream down"), { code: "rpc-error" });
    vi.mocked(pluginManager.invoke)
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockRejectedValueOnce(boom);

    const status = await getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({
      state: "errored",
      detail: "upstream down",
      checkedAt: FROZEN_TIME.toISOString(),
    });
  });

  it("reports errored when getConnectionStatus throws a non-MethodNotFound error", async () => {
    const boom = Object.assign(new Error("connection refused"), { code: "rpc-error" });
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(boom);

    const status = await getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(status).toEqual({
      state: "errored",
      detail: "connection refused",
      checkedAt: FROZEN_TIME.toISOString(),
    });
    // Did not attempt validateConfig fallback because the failure wasn't MethodNotFound.
    expect(pluginManager.invoke).toHaveBeenCalledTimes(1);
  });

  it("produces a parseable ISO-8601 checkedAt in fallback paths", async () => {
    vi.mocked(pluginManager.invoke)
      .mockRejectedValueOnce(methodNotFound("getConnectionStatus"))
      .mockResolvedValueOnce({ ok: true });

    const status = await getConnectionStatus(PLUGIN_ID, CONFIG);

    expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  });
});
