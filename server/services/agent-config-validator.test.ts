import { describe, it, expect, beforeEach } from "vitest";
import type { PluginManifest } from "@roubo/shared";
import { validateAgentConfig, resetAgentConfigValidatorCache } from "./agent-config-validator.js";

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "claude-code",
    name: "Claude Code",
    version: "1.0.0",
    kind: "agent",
    ...overrides,
  } as PluginManifest;
}

const CLAUDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    model: { type: "string", enum: ["sonnet", "opus", "haiku"] },
    permissionMode: { type: "string", enum: ["default", "plan", "acceptEdits"] },
    maxTurns: { type: "integer" },
  },
};

const CODEX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reasoningEffort: { type: "string", enum: ["low", "medium", "high"] },
    approvalPolicy: { type: "string", enum: ["untrusted", "on-failure", "never"] },
    sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
  },
};

beforeEach(() => {
  resetAgentConfigValidatorCache();
});

describe("validateAgentConfig", () => {
  it("accepts any config when the plugin declares no configSchema", () => {
    expect(validateAgentConfig(manifest(), { anything: 1 })).toEqual([]);
  });

  it("accepts a config every field of which is in range", () => {
    const m = manifest({ configSchema: CLAUDE_SCHEMA });
    expect(validateAgentConfig(m, { model: "opus", permissionMode: "plan", maxTurns: 12 })).toEqual(
      [],
    );
  });

  it("rejects an out-of-enum value, naming the field and its allowed values (AP-TC-011)", () => {
    const m = manifest({ configSchema: CLAUDE_SCHEMA });
    const errors = validateAgentConfig(m, { model: "gpt-5" });
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("model");
    expect(errors[0].message).toBe("Must be one of: sonnet, opus, haiku");
  });

  it("reports every offending field at once", () => {
    const m = manifest({ configSchema: CLAUDE_SCHEMA });
    const errors = validateAgentConfig(m, { model: "gpt-5", permissionMode: "yolo" });
    expect(errors.map((e) => e.path).sort()).toEqual(["model", "permissionMode"]);
  });

  it("names an unexpected property rather than reporting a bare failure", () => {
    const m = manifest({ configSchema: CLAUDE_SCHEMA });
    const errors = validateAgentConfig(m, { nonsense: true });
    expect(errors[0].message).toBe("Unexpected property 'nonsense'");
  });

  it("validates each plugin against its own schema, never another's (AP-TC-003)", () => {
    const claude = manifest({ configSchema: CLAUDE_SCHEMA });
    const codex = manifest({ id: "codex-cli", name: "Codex CLI", configSchema: CODEX_SCHEMA });

    // A value valid for one plugin is rejected by the other.
    expect(validateAgentConfig(claude, { model: "opus" })).toEqual([]);
    expect(validateAgentConfig(codex, { model: "opus" })).not.toEqual([]);
    expect(validateAgentConfig(codex, { reasoningEffort: "high" })).toEqual([]);
    expect(validateAgentConfig(claude, { reasoningEffort: "high" })).not.toEqual([]);
  });

  it("recompiles when a plugin's version changes so a stale schema is never reused", () => {
    const before = manifest({ version: "1.0.0", configSchema: CLAUDE_SCHEMA });
    expect(validateAgentConfig(before, { reasoningEffort: "high" })).not.toEqual([]);

    const after = manifest({ version: "2.0.0", configSchema: CODEX_SCHEMA });
    expect(validateAgentConfig(after, { reasoningEffort: "high" })).toEqual([]);
  });

  it("accepts anything when the configSchema is malformed and cannot compile", () => {
    const m = manifest({ configSchema: { type: "not-a-json-schema-type" } });
    expect(validateAgentConfig(m, { whatever: true })).toEqual([]);
  });
});
