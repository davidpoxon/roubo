import { beforeEach, describe, expect, it } from "vitest";
import {
  getActiveConfig,
  getPrimarySource,
  parseConfig,
  setActiveConfig,
  tryGetActiveConfig,
} from "../active-config.js";

const VALID_INSTANCE = "https://ghe.example.com";

describe("active-config", () => {
  beforeEach(() => {
    setActiveConfig(null);
  });

  describe("parseConfig", () => {
    it("returns a typed config on the happy path", () => {
      const { config, errors } = parseConfig({
        instance: VALID_INSTANCE,
        sources: [
          { kind: "repo", externalId: "foo/bar" },
          { kind: "project", externalId: "foo/#3" },
        ],
      });
      expect(errors).toEqual([]);
      expect(config).toEqual({
        instance: VALID_INSTANCE,
        allowSelfSignedTls: false,
        sources: [
          { kind: "repo", externalId: "foo/bar" },
          { kind: "project", externalId: "foo/#3" },
        ],
      });
    });

    it("accepts allowSelfSignedTls=true and strips a trailing slash from instance", () => {
      const { config, errors } = parseConfig({
        instance: `${VALID_INSTANCE}/`,
        allowSelfSignedTls: true,
        sources: [{ kind: "repo", externalId: "foo/bar" }],
      });
      expect(errors).toEqual([]);
      expect(config).toEqual({
        instance: VALID_INSTANCE,
        allowSelfSignedTls: true,
        sources: [{ kind: "repo", externalId: "foo/bar" }],
      });
    });

    it("rejects missing instance", () => {
      const { config, errors } = parseConfig({ sources: [] });
      expect(config).toBeNull();
      expect(errors).toContainEqual({
        field: "instance",
        message: "instance must be a non-empty string",
      });
    });

    it("rejects non-http(s) instance", () => {
      const { config, errors } = parseConfig({ instance: "ftp://ghe.example.com", sources: [] });
      expect(config).toBeNull();
      expect(errors).toContainEqual({
        field: "instance",
        message: "instance must be an http(s) URL",
      });
    });

    it("rejects a malformed instance URL", () => {
      const { config, errors } = parseConfig({ instance: "not a url", sources: [] });
      expect(config).toBeNull();
      expect(errors).toContainEqual({
        field: "instance",
        message: "instance is not a valid URL",
      });
    });

    it("rejects a non-boolean allowSelfSignedTls", () => {
      const { config, errors } = parseConfig({
        instance: VALID_INSTANCE,
        allowSelfSignedTls: "yes",
        sources: [],
      });
      expect(config).toBeNull();
      expect(errors).toContainEqual({
        field: "allowSelfSignedTls",
        message: "must be a boolean",
      });
    });

    it("rejects missing sources array", () => {
      const { config, errors } = parseConfig({ instance: VALID_INSTANCE });
      expect(config).toBeNull();
      expect(errors[0]).toEqual({ field: "sources", message: "sources must be an array" });
    });

    it("collects per-entry errors and rejects the config", () => {
      const { config, errors } = parseConfig({
        instance: VALID_INSTANCE,
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
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
      sources: [
        { kind: "repo", externalId: "foo/bar" },
        { kind: "project", externalId: "foo/#1" },
      ],
    });
    expect(getPrimarySource()).toEqual({ kind: "repo", externalId: "foo/bar" });
  });

  it("getPrimarySource throws when sources is empty", () => {
    setActiveConfig({ instance: VALID_INSTANCE, allowSelfSignedTls: false, sources: [] });
    expect(() => getPrimarySource()).toThrow(/no sources/);
  });
});
