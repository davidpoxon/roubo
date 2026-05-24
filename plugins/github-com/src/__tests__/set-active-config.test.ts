import { beforeEach, describe, expect, it } from "vitest";
import { setActiveConfig, tryGetActiveConfig } from "../active-config.js";
import { setActiveConfigMethod } from "../methods/set-active-config.js";

describe("setActiveConfig RPC", () => {
  beforeEach(() => {
    setActiveConfig(null);
  });

  it("sets the active config when sources are well-formed", () => {
    const result = setActiveConfigMethod({
      config: { sources: [{ kind: "repo", externalId: "foo/bar" }] },
    });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      sources: [{ kind: "repo", externalId: "foo/bar" }],
    });
  });

  it("returns shape errors and leaves active config untouched", () => {
    setActiveConfig({ sources: [{ kind: "repo", externalId: "previous/one" }] });
    const result = setActiveConfigMethod({ config: { sources: "no" } });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "sources",
      message: "sources must be an array",
    });
    expect(tryGetActiveConfig()).toEqual({
      sources: [{ kind: "repo", externalId: "previous/one" }],
    });
  });

  it("accepts an empty sources list (caller is responsible for source presence)", () => {
    // Empty-sources activation is legitimate when the host is staging the
    // plugin between projects; downstream source-bound methods will throw a
    // clear "no sources" error if one is invoked while empty.
    const result = setActiveConfigMethod({ config: { sources: [] } });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({ sources: [] });
  });
});
