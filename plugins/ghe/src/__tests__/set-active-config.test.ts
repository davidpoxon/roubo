import { beforeEach, describe, expect, it } from "vitest";
import { setActiveConfig, tryGetActiveConfig } from "../active-config.js";
import { setActiveConfigMethod } from "../methods/set-active-config.js";

const VALID_INSTANCE = "https://ghe.example.com";

describe("setActiveConfig RPC", () => {
  beforeEach(() => {
    setActiveConfig(null);
  });

  it("sets the plugin-wide active config when instance is well-formed", () => {
    const result = setActiveConfigMethod({ config: { instance: VALID_INSTANCE } });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
    });
  });

  it("returns shape errors and leaves active config untouched", () => {
    setActiveConfig({ instance: VALID_INSTANCE, allowSelfSignedTls: false });
    const result = setActiveConfigMethod({ config: { instance: "" } });
    expect(result.ok).toBe(false);
    expect(result.errors?.[0]).toEqual({
      field: "instance",
      message: "instance must be a non-empty string",
    });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: false,
    });
  });

  it("accepts allowSelfSignedTls=true", () => {
    const result = setActiveConfigMethod({
      config: { instance: VALID_INSTANCE, allowSelfSignedTls: true },
    });
    expect(result).toEqual({ ok: true });
    expect(tryGetActiveConfig()).toEqual({
      instance: VALID_INSTANCE,
      allowSelfSignedTls: true,
    });
  });
});
