import { beforeEach, describe, expect, it } from "vitest";
import { setActiveConfig, tryGetActiveConfig } from "../active-config.js";
import { setActiveConfigMethod } from "../methods/set-active-config.js";

const VALID_INSTANCE = "https://ghe.example.com";

describe("setActiveConfig RPC", () => {
  beforeEach(() => {
    setActiveConfig(null);
  });

  it("sets the active config when sources + instance are well-formed", () => {
    const result = setActiveConfigMethod({
      config: {
        instance: VALID_INSTANCE,
        sources: [{ kind: "repo", externalId: "foo/bar" }],
      },
    });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
      sources: [{ kind: "repo", externalId: "foo/bar" }],
    });
  });

  it("returns shape errors and leaves active config untouched", () => {
    setActiveConfig({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
      sources: [{ kind: "repo", externalId: "previous/one" }],
    });
    const result = setActiveConfigMethod({
      config: { instance: VALID_INSTANCE, sources: "no" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "sources",
      message: "sources must be an array",
    });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
      sources: [{ kind: "repo", externalId: "previous/one" }],
    });
  });

  it("accepts an empty sources list", () => {
    const result = setActiveConfigMethod({
      config: { instance: VALID_INSTANCE, sources: [] },
    });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
      sources: [],
    });
  });
});
