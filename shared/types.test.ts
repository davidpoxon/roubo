import { describe, it, expect } from "vitest";
import {
  deriveClaudeCodeMode,
  GLOBAL_DEFAULT_BLUEPRINT_ID,
  DEFAULT_BLUEPRINT_SETTINGS,
} from "./types.js";
import type {
  BlueprintSource,
  BlueprintSettings,
  BlueprintMeta,
  ProjectConfig,
  NormalizedIssue,
} from "./types.js";

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

describe("NormalizedIssue contract", () => {
  // TC-024: every key the contract names must be present, and the listed
  // deprecated fields (sprint, fixVersion, custom fields, attachments, comments,
  // parent, children, epic) must NOT be part of the type. We anchor both halves
  // at compile time: the Record<keyof, true> errors if a contract key is removed,
  // and the never-mapped object errors if a deprecated key sneaks back in.

  it("carries the 14 contract fields and no deprecated fields", () => {
    const fields: Record<keyof NormalizedIssue, true> = {
      integrationId: true,
      externalId: true,
      externalUrl: true,
      title: true,
      body: true,
      currentState: true,
      allowedTransitions: true,
      assignees: true,
      labels: true,
      issueType: true,
      blocks: true,
      blockedBy: true,
      updatedAt: true,
      raw: true,
    };
    expect(Object.keys(fields).sort()).toEqual(
      [
        "integrationId",
        "externalId",
        "externalUrl",
        "title",
        "body",
        "currentState",
        "allowedTransitions",
        "assignees",
        "labels",
        "issueType",
        "blocks",
        "blockedBy",
        "updatedAt",
        "raw",
      ].sort(),
    );

    type Deprecated =
      | "sprint"
      | "fixVersion"
      | "customFields"
      | "attachments"
      | "comments"
      | "parent"
      | "children"
      | "epic";
    // Compile-time: this type is `never` only if no Deprecated key collides
    // with a NormalizedIssue key. If a future edit re-adds e.g. `comments`,
    // the assignment below errors.
    type NoDeprecatedKeys = Extract<keyof NormalizedIssue, Deprecated>;
    const _check: NoDeprecatedKeys extends never ? true : false = true;
    expect(_check).toBe(true);
  });

  it("accepts a structurally valid value", () => {
    const sample: NormalizedIssue = {
      integrationId: "github-com",
      externalId: "42",
      externalUrl: "https://github.com/org/repo/issues/42",
      title: "Fix login",
      body: null,
      currentState: "open",
      allowedTransitions: ["closed"],
      assignees: [{ externalId: "u1", displayName: "Alice" }],
      labels: ["bug"],
      issueType: null,
      blocks: [],
      blockedBy: ["41"],
      updatedAt: "2026-05-01T00:00:00Z",
      raw: { source: "github" },
    };
    expect(sample.externalId).toBe("42");
  });
});
