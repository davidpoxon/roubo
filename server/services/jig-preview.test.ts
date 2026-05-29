import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RegisteredProject, Bench } from "@roubo/shared";

vi.mock("./config-parser.js", () => ({
  buildTemplateContext: vi.fn(() => ({
    ports: { server: 4000 },
    portHttps: { server: false },
    workspace: "/real/workspace",
    components: {},
  })),
  applyContainerOverrides: vi.fn(),
}));

vi.mock("./issue-formatting.js", () => ({
  fetchIssueContext: vi.fn(),
}));

import {
  getSampleResolveContext,
  buildPreviewContext,
  findUnresolvedVariables,
} from "./jig-preview.js";
import { buildTemplateContext, applyContainerOverrides } from "./config-parser.js";
import { fetchIssueContext } from "./issue-formatting.js";

const MOCK_PROJECT: RegisteredProject = {
  id: "proj-1",
  repoPath: "/repos/proj-1",
  config: {
    project: { displayName: "My Project", repo: "org/repo" },
    ports: {},
    components: {},
  } as RegisteredProject["config"],
  configValid: true,
  settings: {} as RegisteredProject["settings"],
};

const MOCK_BENCH: Bench = {
  id: 2,
  projectId: "proj-1",
  branch: "feature/real-branch",
  workspacePath: "/real/workspace",
  status: "active",
  ports: { server: 4000 },
  components: {},
  createdAt: "2024-01-01T00:00:00.000Z",
  provisioningSteps: [],
  teardownSteps: [],
  notifications: [],
  assignedIssue: { number: 99, title: "Real issue" },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getSampleResolveContext", () => {
  it("returns deterministic sample data", () => {
    const ctx = getSampleResolveContext();
    expect(ctx.benchId).toBe(1);
    expect(ctx.benchBranch).toBe("feature/my-change");
    expect(ctx.projectName).toBe("my-app");
    expect(ctx.issueNumber).toBe(42);
    expect(ctx.issueTitle).toBe("Fix login bug");
    expect(ctx.issueUrl).toBe("https://github.com/org/repo/issues/42");
    expect(ctx.workspace).toBe("~/.roubo/workspaces/my-app/bench-1");
    expect(ctx.ports).toBeDefined();
    expect(ctx.portHttps).toBeDefined();
    expect(ctx.components).toBeDefined();
  });

  it("returns a fresh object each call", () => {
    const a = getSampleResolveContext();
    const b = getSampleResolveContext();
    expect(a).not.toBe(b);
  });
});

describe("buildPreviewContext", () => {
  it("returns sample context when project has no config", async () => {
    const noConfigProject: RegisteredProject = { ...MOCK_PROJECT, config: undefined };
    const ctx = await buildPreviewContext(noConfigProject, MOCK_BENCH);
    expect(ctx).toEqual(getSampleResolveContext());
    expect(buildTemplateContext).not.toHaveBeenCalled();
  });

  it("builds real context from bench data", async () => {
    vi.mocked(fetchIssueContext).mockResolvedValue({
      issueNumber: 99,
      issueTitle: "Real issue",
      issueBody: "Body text",
      issueUrl: "https://github.com/org/repo/issues/99",
      comments: "",
    });

    const ctx = await buildPreviewContext(MOCK_PROJECT, MOCK_BENCH);

    expect(buildTemplateContext).toHaveBeenCalledWith(MOCK_PROJECT.config, 2, "/real/workspace");
    expect(applyContainerOverrides).toHaveBeenCalledWith(
      expect.objectContaining({ ports: { server: 4000 } }),
      undefined,
    );
    expect(ctx.benchBranch).toBe("feature/real-branch");
    expect(ctx.benchId).toBe(2);
    expect(ctx.projectName).toBe("My Project");
    expect(ctx.issueNumber).toBe(99);
    expect(ctx.issueTitle).toBe("Real issue");
    expect(ctx.issueBody).toBe("Body text");
    expect(ctx.workspace).toBe("/real/workspace");
  });

  it("falls back to persisted issue stub when fetchIssueContext fails", async () => {
    vi.mocked(fetchIssueContext).mockRejectedValue(new Error("GitHub unavailable"));

    const ctx = await buildPreviewContext(MOCK_PROJECT, MOCK_BENCH);

    expect(ctx.issueNumber).toBe(99);
    expect(ctx.issueTitle).toBe("Real issue");
    expect(ctx.issueBody).toBeUndefined();
  });

  it("re-hydrates alert-backed benches from persisted raw without fetching", async () => {
    const alertBench: Bench = {
      ...MOCK_BENCH,
      assignedIssue: {
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
      },
    };

    const ctx = await buildPreviewContext(MOCK_PROJECT, alertBench);

    expect(fetchIssueContext).not.toHaveBeenCalled();
    expect(ctx.issueNumber).toBe(117);
    expect(ctx.issueTitle).toBe("SQL injection");
    expect(ctx.issueBody).toContain("**Location:** src/db.ts:12");
    expect(ctx.issueUrl).toBe("https://github.com/org/repo/security/code-scanning/117");
  });

  it("skips issue fetch when bench has no assigned issue", async () => {
    const benchNoIssue: Bench = { ...MOCK_BENCH, assignedIssue: undefined };
    await buildPreviewContext(MOCK_PROJECT, benchNoIssue);
    expect(fetchIssueContext).not.toHaveBeenCalled();
  });

  it("skips issue fetch when project config has no repo", async () => {
    const projectNoRepo: RegisteredProject = {
      ...MOCK_PROJECT,
      config: {
        ...(MOCK_PROJECT.config ?? {}),
        project: { displayName: "No Repo Project" },
      } as RegisteredProject["config"],
    };
    await buildPreviewContext(projectNoRepo, MOCK_BENCH);
    expect(fetchIssueContext).not.toHaveBeenCalled();
  });
});

describe("findUnresolvedVariables", () => {
  it("returns empty array when there are no placeholders", () => {
    expect(findUnresolvedVariables("hello world")).toEqual([]);
    expect(findUnresolvedVariables("")).toEqual([]);
  });

  it("returns a placeholder that remains in resolved text", () => {
    expect(findUnresolvedVariables("{{bench.branch}}")).toEqual(["{{bench.branch}}"]);
  });

  it("deduplicates repeated placeholders", () => {
    const result = findUnresolvedVariables("{{bench.branch}} and {{bench.branch}} again");
    expect(result).toEqual(["{{bench.branch}}"]);
  });

  it("returns multiple distinct placeholders", () => {
    const result = findUnresolvedVariables("{{ports.server}} and {{user.email}}");
    expect(result).toContain("{{ports.server}}");
    expect(result).toContain("{{user.email}}");
    expect(result).toHaveLength(2);
  });

  it("does not return resolved content as unresolved", () => {
    expect(findUnresolvedVariables("feature/my-change on bench 1")).toEqual([]);
  });
});
