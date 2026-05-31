import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "@roubo/shared";
import { filterAdvancedAgainstManifest, stripTopLevelKeyShadows } from "./plugin-config-filter.js";

function manifest(configSchema: Record<string, unknown> | undefined): PluginManifest {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "0.0.0",
    description: "fixture",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "./index.js",
    permissions: {},
    ...(configSchema ? { configSchema } : {}),
  } as PluginManifest;
}

describe("filterAdvancedAgainstManifest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps keys the manifest declares (e.g. allowSelfSignedTls)", () => {
    const m = manifest({
      type: "object",
      properties: {
        instance: { type: "string" },
        allowSelfSignedTls: { type: "boolean" },
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = filterAdvancedAgainstManifest("ghe", { allowSelfSignedTls: true }, m, "activation");

    expect(out).toEqual({ allowSelfSignedTls: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops keys that shadow top-level IntegrationConfig fields, even if the manifest lists them (issue #125 `advanced.sources`)", () => {
    // github-com's manifest declares `sources` in configSchema (because the
    // Configure dialog uses that to drive the per-source UI), but `sources`
    // belongs at the top level of the integration config, never under
    // `advanced`. So an `advanced.sources` leftover must be stripped.
    const m = manifest({
      type: "object",
      properties: {
        sources: { type: "array" },
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = filterAdvancedAgainstManifest("github-com", { sources: "" }, m, "activation");

    expect(out).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("github-com: dropping stale advanced keys not in manifest"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("advanced.sources"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("source=activation"));
  });

  it("drops every advanced key when the manifest has no configSchema", () => {
    const m = manifest(undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = filterAdvancedAgainstManifest(
      "no-schema-plugin",
      { foo: 1, bar: 2 },
      m,
      "persist-global",
    );

    expect(out).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("advanced.foo"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("advanced.bar"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("source=persist-global"));
  });

  it("drops every advanced key when configSchema is present but has no properties block", () => {
    const m = manifest({ type: "object" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = filterAdvancedAgainstManifest("headless-schema", { foo: 1 }, m, "persist-project");

    expect(out).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("drops every advanced key when no manifest is available at all", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = filterAdvancedAgainstManifest("unknown", { foo: 1 }, null, "activation");

    expect(out).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("returns undefined and does not warn for empty/undefined advanced", () => {
    const m = manifest({ type: "object", properties: { allowSelfSignedTls: {} } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(filterAdvancedAgainstManifest("ghe", undefined, m, "activation")).toBeUndefined();
    expect(filterAdvancedAgainstManifest("ghe", {}, m, "activation")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("emits a single warn per call carrying every dropped key", () => {
    const m = manifest({
      type: "object",
      properties: { allowSelfSignedTls: { type: "boolean" }, sources: { type: "array" } },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const out = filterAdvancedAgainstManifest(
      "ghe",
      { allowSelfSignedTls: true, sources: "", legacyToggle: 1 },
      m,
      "activation",
    );

    expect(out).toEqual({ allowSelfSignedTls: true });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(warn).mock.calls[0]?.[0] as string;
    expect(msg).toContain("advanced.sources");
    expect(msg).toContain("advanced.legacyToggle");
  });

  it("treats values that are not objects (defence in depth) as nothing to filter", () => {
    const m = manifest({ type: "object", properties: { foo: {} } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The schema enforces `advanced` is an object, but the helper is called
    // with values that have already passed Zod parsing; defend anyway.
    expect(
      filterAdvancedAgainstManifest(
        "x",
        "not-an-object" as unknown as Record<string, unknown>,
        m,
        "activation",
      ),
    ).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("stripTopLevelKeyShadows", () => {
  it("drops keys that shadow top-level IntegrationConfig fields", () => {
    expect(stripTopLevelKeyShadows({ sources: "", legitToggle: true })).toEqual({
      legitToggle: true,
    });
  });

  it("drops every shadow key it recognises", () => {
    expect(
      stripTopLevelKeyShadows({
        sources: "",
        plugin: "github-com",
        instance: "https://example.com",
        capturedUserId: { externalId: "x" },
        keep: 1,
      }),
    ).toEqual({ keep: 1 });
  });

  it("returns undefined when every key is a shadow (so callers can drop `advanced`)", () => {
    expect(stripTopLevelKeyShadows({ sources: "" })).toBeUndefined();
  });

  it("returns undefined for empty/undefined input", () => {
    expect(stripTopLevelKeyShadows(undefined)).toBeUndefined();
    expect(stripTopLevelKeyShadows({})).toBeUndefined();
  });

  it("leaves a clean advanced block untouched", () => {
    expect(stripTopLevelKeyShadows({ allowSelfSignedTls: true, pageHint: 5 })).toEqual({
      allowSelfSignedTls: true,
      pageHint: 5,
    });
  });

  it("does not mutate its input", () => {
    const input = { sources: "", keep: 1 };
    stripTopLevelKeyShadows(input);
    expect(input).toEqual({ sources: "", keep: 1 });
  });

  it("treats a non-object value (defence in depth) as nothing to filter", () => {
    expect(
      stripTopLevelKeyShadows("not-an-object" as unknown as Record<string, unknown>),
    ).toBeUndefined();
  });
});
