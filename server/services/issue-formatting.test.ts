import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AssignedIssue, NormalizedIssue, NormalizedComment } from "@roubo/shared";

vi.mock("./active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(() => ({
    pluginId: "github-com",
    integrationId: "github-com",
    pageSize: 50,
  })),
}));
vi.mock("./plugin-activation.js", () => ({ ensurePluginActivated: vi.fn(async () => {}) }));
vi.mock("./plugin-manager.js", () => ({ invoke: vi.fn() }));

import {
  formatIssueBody,
  formatComments,
  buildPersistedIssueContext,
  resolveAssignedIssueContext,
} from "./issue-formatting.js";
import * as pluginManager from "./plugin-manager.js";
import { resolveActivePlugin } from "./active-plugin.js";

describe("buildPersistedIssueContext", () => {
  it("re-hydrates the issue key + title + URL with no number and no network fields", () => {
    const ctx = buildPersistedIssueContext({
      externalId: "PROJ-3782",
      title: "Add billing dashboard",
      externalUrl: "https://jira.example.com/browse/PROJ-3782",
    });
    expect(ctx).toEqual({
      issueKey: "PROJ-3782",
      issueTitle: "Add billing dashboard",
      issueBody: "",
      issueUrl: "https://jira.example.com/browse/PROJ-3782",
      comments: "",
    });
    expect(ctx.issueNumber).toBeUndefined();
  });

  it("falls back to an empty issueUrl when no externalUrl was persisted", () => {
    const ctx = buildPersistedIssueContext({
      externalId: "PROJ-3782",
      title: "Add billing dashboard",
    });
    expect(ctx.issueUrl).toBe("");
  });

  it("keeps the number, title and persisted URL for a numbered issue, and no body", () => {
    expect(
      buildPersistedIssueContext({
        number: 42,
        externalId: "owner/repo#42",
        title: "Fix the widget",
        externalUrl: "https://github.com/owner/repo/issues/42",
      }),
    ).toEqual({
      issueNumber: 42,
      issueTitle: "Fix the widget",
      issueUrl: "https://github.com/owner/repo/issues/42",
    });
  });
});

describe("formatIssueBody", () => {
  it("returns empty string for null", () => {
    expect(formatIssueBody(null)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(formatIssueBody("")).toBe("");
  });

  it("returns body unchanged when under 10000 chars", () => {
    const body = "short body";
    expect(formatIssueBody(body)).toBe(body);
  });

  it("does not truncate body at exactly 10000 chars", () => {
    const body = "a".repeat(10000);
    expect(formatIssueBody(body)).toBe(body);
  });

  it("truncates body over 10000 chars and appends [truncated]", () => {
    const body = "a".repeat(10001);
    const result = formatIssueBody(body);
    expect(result).toHaveLength(10000 + "\n\n[truncated]".length);
    expect(result.endsWith("\n\n[truncated]")).toBe(true);
    expect(result.startsWith("a".repeat(10000))).toBe(true);
  });
});

describe("formatComments", () => {
  it("returns empty string for empty array", () => {
    expect(formatComments([])).toBe("");
  });

  it("returns comments with ## Comments header when <=50 comments", () => {
    const comments = [
      { user: "alice", body: "Hello" },
      { user: "bob", body: "World" },
    ];
    const result = formatComments(comments);
    expect(result).toContain("## Comments\n");
    expect(result).toContain("**alice:**\nHello");
    expect(result).toContain("**bob:**\nWorld");
  });

  it("returns truncation header when >50 comments", () => {
    const comments = Array.from({ length: 55 }, (_, i) => ({
      user: `user${i}`,
      body: `comment ${i}`,
    }));
    const result = formatComments(comments);
    expect(result).toContain("showing last 50 of 55");
    expect(result).not.toContain("user0"); // first 5 should be excluded
    expect(result).toContain("user54"); // last one should be included
  });
});

function issue(externalId: string): NormalizedIssue {
  const [repo, n] = externalId.split("#");
  return {
    integrationId: "github-com",
    externalId,
    externalUrl: `https://github.com/${repo}/issues/${n}`,
    title: externalId,
    body: `body of ${externalId}`,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2026-01-01T00:00:00Z",
    raw: null,
  };
}

const comment: NormalizedComment = {
  externalId: "c1",
  author: { externalId: "u1", displayName: "octocat" },
  body: "a comment",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.mocked(pluginManager.invoke).mockReset();
  vi.mocked(pluginManager.invoke).mockImplementation(async (_pluginId, method, params) => {
    const { externalId } = params as { externalId: string };
    return (method === "getIssue" ? issue(externalId) : [comment]) as never;
  });
});

describe("assigned issue context (#1461)", () => {
  it("fetches a submodule-source issue by its own externalId, not by number from the root repo", async () => {
    const ctx = await resolveAssignedIssueContext("demo", {
      number: 12,
      integrationId: "github-com",
      externalId: "org/sub#12",
      title: "t",
    } as AssignedIssue);

    expect(ctx.issueBody).toBe("body of org/sub#12");
    expect(ctx.issueUrl).toBe("https://github.com/org/sub/issues/12");
    expect(ctx.issueNumber).toBe(12);
    expect(ctx.comments).toContain("**octocat:**\na comment");
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "org/sub#12",
    });
  });

  it("gives an issue with no number its body and comments, keyed by externalId", async () => {
    vi.mocked(resolveActivePlugin).mockReturnValueOnce({
      pluginId: "jira",
      integrationId: "jira",
      pageSize: 50,
    });
    const ctx = await resolveAssignedIssueContext("demo", {
      integrationId: "jira",
      externalId: "org/k#7",
      title: "t",
    } as AssignedIssue);

    expect(ctx.issueKey).toBe("org/k#7");
    expect(ctx.issueNumber).toBeUndefined();
    expect(ctx.issueBody).toBe("body of org/k#7");
    expect(ctx.comments).toContain("a comment");
  });

  it("uses persisted data when the active plugin is not the issue's integration", async () => {
    vi.mocked(resolveActivePlugin).mockReturnValueOnce({
      pluginId: "ghe",
      integrationId: "ghe",
      pageSize: 50,
    });
    const ctx = await resolveAssignedIssueContext("demo", {
      number: 12,
      integrationId: "github-com",
      externalId: "org/sub#12",
      title: "Persisted",
      externalUrl: "https://github.com/org/sub/issues/12",
    } as AssignedIssue);

    expect(pluginManager.invoke).not.toHaveBeenCalled();
    expect(ctx.issueTitle).toBe("Persisted");
    expect(ctx.issueUrl).toBe("https://github.com/org/sub/issues/12");
    expect(ctx.issueBody).toBeUndefined();
  });

  it("uses persisted data when getIssue fails", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("offline"));
    const ctx = await resolveAssignedIssueContext("demo", {
      number: 12,
      integrationId: "github-com",
      externalId: "org/sub#12",
      title: "P",
    } as AssignedIssue);

    expect(ctx.issueNumber).toBe(12);
    expect(ctx.issueTitle).toBe("P");
    expect(ctx.issueBody).toBeUndefined();
  });

  it("re-hydrates an alert from its persisted raw without any RPC", async () => {
    const ctx = await resolveAssignedIssueContext("demo", {
      number: 117,
      integrationId: "github-com",
      externalId: "org/repo#code-scanning-117",
      title: "SQL injection",
      issueType: "security-code-scanning",
      raw: {
        html_url: "https://github.com/org/repo/security/code-scanning/117",
        rule: { description: "SQL injection", security_severity_level: "high" },
        most_recent_instance: { location: { path: "src/db.ts", start_line: 12 } },
      },
    });

    expect(pluginManager.invoke).not.toHaveBeenCalled();
    expect(ctx.issueNumber).toBe(117);
    expect(ctx.issueBody).toContain("**Location:** src/db.ts:12");
  });

  it("re-hydrates from persisted state when the project has no active plugin", async () => {
    vi.mocked(resolveActivePlugin).mockReturnValueOnce(null);
    const ctx = await resolveAssignedIssueContext("demo", {
      integrationId: "jira-self-hosted",
      externalId: "PROJ-45",
      title: "Add billing dashboard",
      externalUrl: "https://jira.example.com/browse/PROJ-45",
    });

    expect(pluginManager.invoke).not.toHaveBeenCalled();
    expect(ctx).toMatchObject({
      issueKey: "PROJ-45",
      issueTitle: "Add billing dashboard",
      issueUrl: "https://jira.example.com/browse/PROJ-45",
    });
  });

  it("keeps the body when only getComments fails", async () => {
    vi.mocked(pluginManager.invoke).mockImplementation(async (_p, method, params) => {
      if (method === "getComments") throw new Error("rate limited");
      return issue((params as { externalId: string }).externalId) as never;
    });
    const ctx = await resolveAssignedIssueContext("demo", {
      number: 12,
      integrationId: "github-com",
      externalId: "org/sub#12",
      title: "t",
    } as AssignedIssue);

    expect(ctx.issueBody).toBe("body of org/sub#12");
    expect(ctx.comments).toBe("");
  });
});
