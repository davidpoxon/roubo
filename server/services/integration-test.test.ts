import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginRecord } from "@roubo/shared";

vi.mock("./plugin-manager.js", () => ({
  invoke: vi.fn(),
}));
vi.mock("./credential-store.js", () => ({
  set: vi.fn(),
  get: vi.fn(),
}));

import { runIntegrationTest, classifyError, errorMessage } from "./integration-test.js";
import * as pluginManager from "./plugin-manager.js";

beforeEach(() => {
  vi.resetAllMocks();
});

function makeRecord(id: string): PluginRecord {
  return {
    id,
    source: { kind: "bundled" } as never,
    status: "enabled",
    manifest: null,
    error: null,
  } as never;
}

describe("runIntegrationTest", () => {
  it("invokes validateConfig with { config } wrapper (regression: plugin's params.config was undefined)", async () => {
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined) // validateConfig
      .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octocat" });

    const config = { instance: "https://github.example.com", sources: [] };
    const result = await runIntegrationTest(makeRecord("github-com"), config);

    expect(result).toEqual({
      ok: true,
      identity: { externalId: "u-1", displayName: "Octocat" },
    });

    expect(pluginManager.invoke).toHaveBeenNthCalledWith(
      1,
      "github-com",
      "validateConfig",
      { config },
      { timeoutMs: 15_000 },
    );
  });

  it("invokes getCurrentUser with no params (SDK contract: () => CurrentUser)", async () => {
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ externalId: "u-1", displayName: "Octocat" });

    await runIntegrationTest(makeRecord("github-com"), { instance: "x" });

    expect(pluginManager.invoke).toHaveBeenNthCalledWith(
      2,
      "github-com",
      "getCurrentUser",
      {},
      { timeoutMs: 15_000 },
    );
  });

  it("propagates validateConfig rejections and classifies them", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValueOnce(new Error("401 Unauthorized"));
    const result = await runIntegrationTest(makeRecord("github-com"), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("auth");
      expect(result.error.message).toMatch(/401/);
    }
  });

  it("returns a structured error when getCurrentUser returns an invalid shape", async () => {
    vi.mocked(pluginManager.invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ wrong: "shape" });

    const result = await runIntegrationTest(makeRecord("github-com"), {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("other");
      expect(result.error.message).toMatch(/invalid getCurrentUser/);
    }
  });
});

describe("classifyError", () => {
  it("classifies TLS, network, auth, other", () => {
    expect(classifyError("self signed certificate")).toBe("tls");
    expect(classifyError("getaddrinfo ENOTFOUND")).toBe("network");
    expect(classifyError("401 Unauthorized")).toBe("auth");
    expect(classifyError("something else")).toBe("other");
  });
});

describe("errorMessage", () => {
  it("extracts message from Error, string, or unknown", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("Unknown error");
  });
});
