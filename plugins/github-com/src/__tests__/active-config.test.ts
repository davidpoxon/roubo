import { beforeEach, describe, expect, it } from "vitest";
import {
  getActiveConfig,
  getPrimarySource,
  parseConfig,
  setActiveConfig,
  tryGetActiveConfig,
} from "../active-config.js";

describe("active-config", () => {
  beforeEach(() => {
    setActiveConfig(null);
  });

  describe("parseConfig", () => {
    it("returns a typed config on the happy path", () => {
      const { config, errors } = parseConfig({
        sources: [
          { kind: "repo", externalId: "foo/bar" },
          { kind: "project", externalId: "foo/#3" },
        ],
      });
      expect(errors).toEqual([]);
      expect(config).toEqual({
        sources: [
          { kind: "repo", externalId: "foo/bar" },
          { kind: "project", externalId: "foo/#3" },
        ],
      });
    });

    it("rejects missing sources array", () => {
      const { config, errors } = parseConfig({});
      expect(config).toBeNull();
      expect(errors[0]).toEqual({ field: "sources", message: "sources must be an array" });
    });

    it("collects per-entry errors and rejects the config", () => {
      const { config, errors } = parseConfig({
        sources: [{ kind: "wrong", externalId: "foo/bar" }, { externalId: "" }],
      });
      expect(config).toBeNull();
      expect(errors.map((e) => e.field)).toContain("sources[0].kind");
      expect(errors.map((e) => e.field)).toContain("sources[1].kind");
    });
  });

  it("getActiveConfig throws before setActiveConfig is called", () => {
    expect(() => getActiveConfig()).toThrow(/No active configuration/);
    expect(tryGetActiveConfig()).toBeNull();
  });

  it("getPrimarySource returns the first configured source", () => {
    setActiveConfig({
      sources: [
        { kind: "repo", externalId: "foo/bar" },
        { kind: "project", externalId: "foo/#1" },
      ],
    });
    expect(getPrimarySource()).toEqual({ kind: "repo", externalId: "foo/bar" });
  });

  it("getPrimarySource throws when sources is empty", () => {
    setActiveConfig({ sources: [] });
    expect(() => getPrimarySource()).toThrow(/no sources/);
  });
});
