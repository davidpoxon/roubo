import { describe, it, expect } from "vitest";
import { deriveClaudeCodeMode, GLOBAL_DEFAULT_JIG_ID, DEFAULT_JIG_SETTINGS } from "./types.js";
import type { JigSource, JigSettings, JigMeta, ProjectConfig, NormalizedIssue } from "./types.js";

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

describe("jig type exports", () => {
  it("GLOBAL_DEFAULT_JIG_ID is the sentinel string", () => {
    expect(GLOBAL_DEFAULT_JIG_ID).toBe("__global_default__");
  });

  it("DEFAULT_JIG_SETTINGS has autoInject and autoExecute true with no defaultJigId", () => {
    expect(DEFAULT_JIG_SETTINGS.autoInject).toBe(true);
    expect(DEFAULT_JIG_SETTINGS.autoExecute).toBe(true);
    expect(DEFAULT_JIG_SETTINGS).not.toHaveProperty("defaultJigId");
  });

  it("JigSource accepts app and project", () => {
    const app: JigSource = "app";
    const project: JigSource = "project";
    expect(app).toBe("app");
    expect(project).toBe("project");
  });

  it("JigSettings allows optional defaultJigId and issueTypeMappings", () => {
    const minimal: JigSettings = { autoInject: true, autoExecute: false };
    const full: JigSettings = {
      autoInject: true,
      autoExecute: true,
      defaultJigId: "my-jig",
      issueTypeMappings: { Feature: "feature-dev", Bug: "bug-fix" },
    };
    expect(minimal).not.toHaveProperty("defaultJigId");
    expect(full.issueTypeMappings?.["Feature"]).toBe("feature-dev");
  });

  it("JigMeta does not include overrides field", () => {
    const meta: JigMeta = {
      id: "test",
      name: "Test",
      description: "desc",
      icon: "file",
      source: "app",
    };
    expect(meta).not.toHaveProperty("overrides");
  });

  it("ProjectConfig accepts jigSettings", () => {
    const config: ProjectConfig = {
      name: "my-project",
      displayName: "My Project",
      repo: "https://github.com/org/repo",
      jigSettings: {
        autoInject: true,
        autoExecute: false,
        issueTypeMappings: { Feature: "feature-dev" },
      },
    };
    expect(config.jigSettings?.issueTypeMappings?.["Feature"]).toBe("feature-dev");
  });
});

describe("NormalizedIssue contract", () => {
  // TC-024: every key the contract names must be present, and the listed
  // deprecated fields (sprint, fixVersion, custom fields, attachments, comments,
  // parent, children, epic) must NOT be part of the type. We anchor both halves
  // at compile time: the Record<keyof, true> errors if a contract key is removed,
  // and the never-mapped object errors if a deprecated key sneaks back in.

  it("carries the 15 contract fields and no deprecated fields", () => {
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
      facetValues: true,
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
        "facetValues",
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
