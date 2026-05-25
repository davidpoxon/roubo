import { describe, it, expect } from "vitest";
import {
  BUNDLED_PLUGIN_IDS,
  PLUGIN_ENABLE_STATE_SCHEMA_VERSION,
  PluginEnableStateSchema,
  type PluginEnableState,
} from "./plugin-enable-state-schema.js";

function makeState(overrides?: Partial<PluginEnableState>): PluginEnableState {
  return {
    schemaVersion: PLUGIN_ENABLE_STATE_SCHEMA_VERSION,
    installInitialized: true,
    plugins: {
      "github-com": "disabled",
      ghe: "disabled",
      "jira-self-hosted": "disabled",
    },
    ...overrides,
  };
}

describe("PluginEnableStateSchema", () => {
  it("accepts a well-formed greenfield seed", () => {
    const parsed = PluginEnableStateSchema.parse(makeState());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.installInitialized).toBe(true);
    expect(parsed.plugins["github-com"]).toBe("disabled");
  });

  it("accepts an empty plugins map", () => {
    const parsed = PluginEnableStateSchema.parse(makeState({ plugins: {} }));
    expect(parsed.plugins).toEqual({});
  });

  it("rejects a schemaVersion other than 1", () => {
    const result = PluginEnableStateSchema.safeParse({
      ...makeState(),
      schemaVersion: 2 as unknown as 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown enable values", () => {
    const result = PluginEnableStateSchema.safeParse({
      ...makeState(),
      plugins: { "github-com": "on" as unknown as "enabled" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra top-level keys (strict)", () => {
    const result = PluginEnableStateSchema.safeParse({
      ...makeState(),
      extra: true,
    });
    expect(result.success).toBe(false);
  });

  it("requires installInitialized", () => {
    const { installInitialized: _omit, ...rest } = makeState();
    void _omit;
    const result = PluginEnableStateSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe("BUNDLED_PLUGIN_IDS", () => {
  it("matches the three bundled plugin manifest ids", () => {
    expect([...BUNDLED_PLUGIN_IDS].sort()).toEqual(["ghe", "github-com", "jira-self-hosted"]);
  });
});
