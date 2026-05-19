import { describe, it, expect } from "vitest";
import {
  deriveClaudeCodeMode,
  GLOBAL_DEFAULT_BLUEPRINT_ID,
  DEFAULT_BLUEPRINT_SETTINGS,
} from "./types.js";
import type { BlueprintSource, BlueprintSettings, BlueprintMeta, ProjectConfig } from "./types.js";

describe("deriveClaudeCodeMode", () => {
  it('returns "auto" when enableAutoMode is true and startInPlanMode is false', () => {
    expect(deriveClaudeCodeMode({ enableAutoMode: true, startInPlanMode: false })).toBe("auto");
  });

  it('returns "plan-auto" when both enableAutoMode and startInPlanMode are true', () => {
    expect(deriveClaudeCodeMode({ enableAutoMode: true, startInPlanMode: true })).toBe("plan-auto");
  });

  it('returns "plan" when only startInPlanMode is true', () => {
    expect(deriveClaudeCodeMode({ enableAutoMode: false, startInPlanMode: true })).toBe("plan");
  });

  it("returns undefined when both flags are false", () => {
    expect(deriveClaudeCodeMode({ enableAutoMode: false, startInPlanMode: false })).toBeUndefined();
  });

  it("returns undefined when settings is undefined", () => {
    expect(deriveClaudeCodeMode(undefined)).toBeUndefined();
  });
});

describe("blueprint type exports", () => {
  it("GLOBAL_DEFAULT_BLUEPRINT_ID is the sentinel string", () => {
    expect(GLOBAL_DEFAULT_BLUEPRINT_ID).toBe("__global_default__");
  });

  it("DEFAULT_BLUEPRINT_SETTINGS has autoInject and autoExecute true with no defaultBlueprintId", () => {
    expect(DEFAULT_BLUEPRINT_SETTINGS.autoInject).toBe(true);
    expect(DEFAULT_BLUEPRINT_SETTINGS.autoExecute).toBe(true);
    expect(DEFAULT_BLUEPRINT_SETTINGS).not.toHaveProperty("defaultBlueprintId");
  });

  it("BlueprintSource accepts app and project", () => {
    const app: BlueprintSource = "app";
    const project: BlueprintSource = "project";
    expect(app).toBe("app");
    expect(project).toBe("project");
  });

  it("BlueprintSettings allows optional defaultBlueprintId and issueTypeMappings", () => {
    const minimal: BlueprintSettings = { autoInject: true, autoExecute: false };
    const full: BlueprintSettings = {
      autoInject: true,
      autoExecute: true,
      defaultBlueprintId: "my-blueprint",
      issueTypeMappings: { Feature: "feature-dev", Bug: "bug-fix" },
    };
    expect(minimal).not.toHaveProperty("defaultBlueprintId");
    expect(full.issueTypeMappings?.["Feature"]).toBe("feature-dev");
  });

  it("BlueprintMeta does not include overrides field", () => {
    const meta: BlueprintMeta = {
      id: "test",
      name: "Test",
      description: "desc",
      icon: "file",
      source: "app",
    };
    expect(meta).not.toHaveProperty("overrides");
  });

  it("ProjectConfig accepts blueprintSettings", () => {
    const config: ProjectConfig = {
      name: "my-project",
      displayName: "My Project",
      type: "web",
      repo: "https://github.com/org/repo",
      blueprintSettings: {
        autoInject: true,
        autoExecute: false,
        issueTypeMappings: { Feature: "feature-dev" },
      },
    };
    expect(config.blueprintSettings?.issueTypeMappings?.["Feature"]).toBe("feature-dev");
  });
});
