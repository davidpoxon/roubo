import { describe, it, expect } from "vitest";
import type { NormalizedIssue, AssignedIssue } from "@roubo/shared";
import { formatAlertBody, buildAlertIssueContext } from "./alert-formatting.js";

function issue(overrides: Partial<NormalizedIssue>): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId: "org/repo#code-scanning-1",
    externalUrl: "https://example/alert",
    title: "t",
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: "security-code-scanning",
    blocks: [],
    blockedBy: [],
    updatedAt: "t",
    raw: {},
    ...overrides,
  };
}

describe("formatAlertBody", () => {
  it("formats a code-scanning alert with rule, severity, and location", () => {
    const body = formatAlertBody(
      issue({
        issueType: "security-code-scanning",
        raw: {
          rule: { id: "js/x", description: "SQL injection", security_severity_level: "high" },
          tool: { name: "CodeQL" },
          most_recent_instance: { location: { path: "src/db.ts", start_line: 12 } },
        },
      }),
    );
    expect(body).toContain("**Rule:** SQL injection");
    expect(body).toContain("**Severity:** high");
    expect(body).toContain("**Location:** src/db.ts:12");
    expect(body).toContain("**Tool:** CodeQL");
    expect(body).toContain("**Alert URL:** https://example/alert");
  });

  it("formats a secret-scanning alert from metadata only, never the literal", () => {
    const literal = "ghp_SECRETSECRETSECRETSECRET";
    const body = formatAlertBody(
      issue({
        issueType: "security-secret-scanning",
        externalId: "org/repo#secret-scanning-9",
        raw: {
          secret_type_display_name: "GitHub PAT",
          validity: "active",
          resolution: null,
          secret: literal,
        },
      }),
    );
    expect(body).toContain("**Secret type:** GitHub PAT");
    expect(body).toContain("**Validity:** active");
    expect(body).not.toContain(literal);
  });

  it("formats a dependabot alert with advisory and package", () => {
    const body = formatAlertBody(
      issue({
        issueType: "security-dependabot",
        externalId: "org/repo#dependabot-3",
        raw: {
          security_advisory: {
            ghsa_id: "GHSA-xxxx",
            summary: "Prototype pollution",
            severity: "moderate",
          },
          dependency: {
            package: { ecosystem: "npm", name: "lodash" },
            manifest_path: "package.json",
          },
          security_vulnerability: { first_patched_version: { identifier: "4.17.21" } },
        },
      }),
    );
    expect(body).toContain("**Advisory:** Prototype pollution");
    expect(body).toContain("**Package:** lodash (npm)");
    expect(body).toContain("**First patched version:** 4.17.21");
  });

  it("falls back to just the alert URL for an unknown issueType", () => {
    const body = formatAlertBody(issue({ issueType: "bug", raw: {} }));
    expect(body).toBe("**Alert URL:** https://example/alert");
  });
});

function assigned(overrides: Partial<AssignedIssue>): AssignedIssue {
  return {
    number: 117,
    integrationId: "github-com",
    externalId: "org/repo#code-scanning-117",
    title: "SQL injection in db layer",
    issueType: "security-code-scanning",
    raw: {},
    ...overrides,
  };
}

describe("buildAlertIssueContext", () => {
  it("re-hydrates a code-scanning context from the persisted redacted raw", () => {
    const ctx = buildAlertIssueContext(
      assigned({
        raw: {
          html_url: "https://github.com/org/repo/security/code-scanning/117",
          rule: { id: "js/x", description: "SQL injection", security_severity_level: "high" },
          tool: { name: "CodeQL" },
          most_recent_instance: { location: { path: "src/db.ts", start_line: 12 } },
        },
      }),
    );
    expect(ctx.issueNumber).toBe(117);
    expect(ctx.issueTitle).toBe("SQL injection in db layer");
    expect(ctx.issueBody).toContain("**Rule:** SQL injection");
    expect(ctx.issueBody).toContain("**Location:** src/db.ts:12");
    expect(ctx.issueUrl).toBe("https://github.com/org/repo/security/code-scanning/117");
    expect(ctx.issueBody).toContain(
      "**Alert URL:** https://github.com/org/repo/security/code-scanning/117",
    );
    expect(ctx.comments).toBe("");
  });

  it("derives issueUrl from raw.html_url for a secret-scanning context", () => {
    const ctx = buildAlertIssueContext(
      assigned({
        externalId: "org/repo#secret-scanning-9",
        issueType: "security-secret-scanning",
        title: "Leaked PAT",
        raw: {
          html_url: "https://github.com/org/repo/security/secret-scanning/9",
          secret_type_display_name: "GitHub PAT",
          validity: "active",
          secret: "ghp_SECRETSECRETSECRET",
        },
      }),
    );
    expect(ctx.issueUrl).toBe("https://github.com/org/repo/security/secret-scanning/9");
    expect(ctx.issueBody).toContain("**Secret type:** GitHub PAT");
    expect(ctx.issueBody).not.toContain("ghp_SECRETSECRETSECRET");
  });

  it("re-hydrates a dependabot context", () => {
    const ctx = buildAlertIssueContext(
      assigned({
        externalId: "org/repo#dependabot-3",
        issueType: "security-dependabot",
        title: "lodash advisory",
        raw: {
          html_url: "https://github.com/org/repo/security/dependabot/3",
          security_advisory: { summary: "Prototype pollution", severity: "moderate" },
          dependency: { package: { ecosystem: "npm", name: "lodash" } },
        },
      }),
    );
    expect(ctx.issueBody).toContain("**Advisory:** Prototype pollution");
    expect(ctx.issueBody).toContain("**Package:** lodash (npm)");
    expect(ctx.issueUrl).toBe("https://github.com/org/repo/security/dependabot/3");
  });

  it("degrades gracefully when raw is absent", () => {
    const ctx = buildAlertIssueContext(assigned({ raw: undefined }));
    expect(ctx.issueNumber).toBe(117);
    expect(ctx.issueTitle).toBe("SQL injection in db layer");
    expect(ctx.issueUrl).toBe("");
    expect(ctx.issueBody).toBe("");
    expect(ctx.comments).toBe("");
  });
});
