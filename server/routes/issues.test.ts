import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { ServiceError } from "../services/service-error.js";

vi.mock("../services/github.js", () => ({
  fetchIssues: vi.fn(),
  fetchIssueDetail: vi.fn(),
  fetchIssueComments: vi.fn(),
  fetchLabels: vi.fn(),
  fetchProjectItems: vi.fn(),
  fetchBlockingRelationships: vi.fn(),
}));

vi.mock("../services/issue-assignment.js", () => ({
  assignIssue: vi.fn(),
  unassignIssue: vi.fn(),
}));

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../services/state.js", () => ({
  loadSettings: vi.fn(),
}));

import router from "./issues.js";
import * as githubService from "../services/github.js";
import * as issueAssignment from "../services/issue-assignment.js";
import * as projectRegistry from "../services/project-registry.js";
import * as state from "../services/state.js";

const app = express();
app.use(express.json());
app.use("/", router);

describe("GET /:projectId/issues", () => {
  beforeEach(() => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/project1/issues");
    expect(res.status).toBe(404);
  });

  it("returns issues list", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    const issues = [{ number: 1, title: "Test" }];
    vi.mocked(githubService.fetchIssues).mockResolvedValue(issues as any);

    const res = await request(app).get("/project1/issues");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(issues);
  });

  it("passes search and label params", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchIssues).mockResolvedValue([]);

    await request(app).get("/project1/issues?search=bug&labels=critical");
    expect(githubService.fetchIssues).toHaveBeenCalledWith("org/repo", {
      labels: "critical",
      search: "bug",
    });
  });

  it("returns 401 when GITHUB_TOKEN missing", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchIssues).mockRejectedValue(
      new ServiceError(401, "GITHUB_TOKEN environment variable is not set"),
    );

    const res = await request(app).get("/project1/issues");
    expect(res.status).toBe(401);
  });

  it("returns 500 on unexpected error", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchIssues).mockRejectedValue(new Error("network failure"));

    const res = await request(app).get("/project1/issues");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("network failure");
  });

  it("does not call fetchBlockingRelationships when enforcement is disabled", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      benches: { autoClear: true, enforceIssueDependencies: false },
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchIssues).mockResolvedValue([{ number: 1, title: "Test" }] as any);

    await request(app).get("/project1/issues");
    expect(githubService.fetchBlockingRelationships).not.toHaveBeenCalled();
  });

  it("enriches issues with blockedBy data when enforcement is enabled", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      benches: { autoClear: true, enforceIssueDependencies: true },
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    const issues = [
      { number: 1, title: "Test" },
      { number: 2, title: "Other" },
    ];
    vi.mocked(githubService.fetchIssues).mockResolvedValue(issues as any);
    vi.mocked(githubService.fetchBlockingRelationships).mockResolvedValue({
      blockedBy: { 1: [{ number: 5, title: "Blocker" }], 2: [] },
      blockingCount: { 1: 0, 2: 0 },
    });

    const res = await request(app).get("/project1/issues");
    expect(res.status).toBe(200);
    expect(githubService.fetchBlockingRelationships).toHaveBeenCalledWith("org/repo", [1, 2]);
    expect(res.body[0].blockedBy).toEqual([{ number: 5, title: "Blocker" }]);
    expect(res.body[1].blockedBy).toEqual([]);
  });
});

describe("GET /:projectId/issues/:number", () => {
  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/project1/issues/1");
    expect(res.status).toBe(404);
  });

  it("returns issue detail", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    const issue = { number: 1, title: "Detail", body: "Full" };
    vi.mocked(githubService.fetchIssueDetail).mockResolvedValue(issue as any);

    const res = await request(app).get("/project1/issues/1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(issue);
  });

  it("returns 400 for non-numeric issue number", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);

    const res = await request(app).get("/project1/issues/abc");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid issue number");
  });

  it("forwards ServiceError status", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchIssueDetail).mockRejectedValue(
      new ServiceError(401, "Unauthorized"),
    );
    const res = await request(app).get("/project1/issues/1");
    expect(res.status).toBe(401);
  });

  it("returns 500 on unexpected error", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchIssueDetail).mockRejectedValue(new Error("network failure"));
    const res = await request(app).get("/project1/issues/1");
    expect(res.status).toBe(500);
  });
});

describe("GET /:projectId/issues/:number/comments", () => {
  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/project1/issues/1/comments");
    expect(res.status).toBe(404);
  });

  it("returns comments", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    const comments = [{ id: 1, body: "Comment" }];
    vi.mocked(githubService.fetchIssueComments).mockResolvedValue(comments as any);

    const res = await request(app).get("/project1/issues/1/comments");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(comments);
  });

  it("returns 400 for non-numeric issue number", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);

    const res = await request(app).get("/project1/issues/abc/comments");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid issue number");
  });

  it("forwards ServiceError status", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchIssueComments).mockRejectedValue(
      new ServiceError(401, "Unauthorized"),
    );
    const res = await request(app).get("/project1/issues/1/comments");
    expect(res.status).toBe(401);
  });

  it("returns 500 on unexpected error", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchIssueComments).mockRejectedValue(new Error("network failure"));
    const res = await request(app).get("/project1/issues/1/comments");
    expect(res.status).toBe(500);
  });
});

describe("invalid bench id", () => {
  it("returns 400 for non-numeric bench id on POST assign-issue", async () => {
    const res = await request(app)
      .post("/project1/benches/abc/assign-issue")
      .send({ issueNumber: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 400 for non-numeric bench id on DELETE assign-issue", async () => {
    const res = await request(app).delete("/project1/benches/abc/assign-issue");
    expect(res.status).toBe(400);
  });
});

describe("POST /:projectId/benches/:id/assign-issue", () => {
  it("assigns an issue to a bench", async () => {
    const result = {
      bench: { id: 1, assignedIssue: { number: 42, title: "Fix" } },
      terminalSessionId: "term-1",
    };
    vi.mocked(issueAssignment.assignIssue).mockResolvedValue(result as any);

    const res = await request(app)
      .post("/project1/benches/1/assign-issue")
      .send({ issueNumber: 42 });

    expect(res.status).toBe(200);
    expect(res.body.terminalSessionId).toBe("term-1");
    expect(issueAssignment.assignIssue).toHaveBeenCalledWith("project1", 1, 42);
  });

  it("returns 400 when issueNumber missing", async () => {
    const res = await request(app).post("/project1/benches/1/assign-issue").send({});

    expect(res.status).toBe(400);
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(issueAssignment.assignIssue).mockRejectedValue(
      new ServiceError(404, "Bench not found"),
    );

    const res = await request(app)
      .post("/project1/benches/1/assign-issue")
      .send({ issueNumber: 1 });

    expect(res.status).toBe(404);
  });

  it("returns 409 with blockedBy when issue is blocked", async () => {
    const err = new ServiceError(409, "Issue is blocked by unresolved dependencies", {
      blockedBy: [{ number: 10, title: "Add auth middleware" }],
    });
    vi.mocked(issueAssignment.assignIssue).mockRejectedValue(err);

    const res = await request(app)
      .post("/project1/benches/1/assign-issue")
      .send({ issueNumber: 42 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue is blocked by unresolved dependencies");
    expect(res.body.blockedBy).toEqual([{ number: 10, title: "Add auth middleware" }]);
  });
});

describe("DELETE /:projectId/benches/:id/assign-issue", () => {
  it("unassigns an issue from a bench", async () => {
    const bench = { id: 1 };
    vi.mocked(issueAssignment.unassignIssue).mockResolvedValue(bench as any);

    const res = await request(app).delete("/project1/benches/1/assign-issue");
    expect(res.status).toBe(200);
  });

  it("returns 400 when no issue assigned", async () => {
    vi.mocked(issueAssignment.unassignIssue).mockRejectedValue(
      new ServiceError(400, "No issue assigned to this bench"),
    );

    const res = await request(app).delete("/project1/benches/1/assign-issue");
    expect(res.status).toBe(400);
  });
});

describe("GET /:projectId/labels", () => {
  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/project1/labels");
    expect(res.status).toBe(404);
  });

  it("returns labels on success", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchLabels).mockResolvedValue(["bug", "feature"]);

    const res = await request(app).get("/project1/labels");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(["bug", "feature"]);
  });

  it("forwards ServiceError status", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchLabels).mockRejectedValue(new ServiceError(401, "Unauthorized"));

    const res = await request(app).get("/project1/labels");
    expect(res.status).toBe(401);
  });

  it("returns 500 on generic error", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchLabels).mockRejectedValue(new Error("network failure"));

    const res = await request(app).get("/project1/labels");
    expect(res.status).toBe(500);
  });
});

describe("GET /:projectId/project-items", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
  });

  it("returns 404 when project not found", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);

    const res = await request(app).get("/project1/project-items?project=1");
    expect(res.status).toBe(404);
  });

  it("returns 400 when project query param missing", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);

    const res = await request(app).get("/project1/project-items");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("returns project items on success", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    const data = { items: [{ issue: { number: 1, title: "Task" } }], projectTitle: "My Project" };
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue(data as any);

    const res = await request(app).get("/project1/project-items?project=5");
    expect(res.status).toBe(200);
    expect(res.body.projectTitle).toBe("My Project");
    expect(githubService.fetchProjectItems).toHaveBeenCalledWith("org/repo", 5);
  });

  it("forwards ServiceError status", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchProjectItems).mockRejectedValue(
      new ServiceError(403, "Forbidden"),
    );

    const res = await request(app).get("/project1/project-items?project=1");
    expect(res.status).toBe(403);
  });

  it("returns 500 on generic error", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchProjectItems).mockRejectedValue(new Error("fetch failed"));

    const res = await request(app).get("/project1/project-items?project=1");
    expect(res.status).toBe(500);
  });

  it("does not call fetchBlockingRelationships when enforcement is disabled", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      benches: { autoClear: true, enforceIssueDependencies: false },
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [{ issue: { number: 1, title: "Task" } }],
      projectTitle: "My Project",
    } as any);

    await request(app).get("/project1/project-items?project=1");
    expect(githubService.fetchBlockingRelationships).not.toHaveBeenCalled();
  });

  it("enriches items with blockedBy data when enforcement is enabled", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      benches: { autoClear: true, enforceIssueDependencies: true },
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [
        { issue: { number: 10, title: "Blocked task" } },
        { issue: { number: 11, title: "Free task" } },
      ],
      projectTitle: "My Project",
    } as any);
    vi.mocked(githubService.fetchBlockingRelationships).mockResolvedValue({
      blockedBy: { 10: [{ number: 5, title: "Blocker issue" }], 11: [] },
      blockingCount: { 10: 0, 11: 0 },
    });

    const res = await request(app).get("/project1/project-items?project=5");
    expect(res.status).toBe(200);
    expect(githubService.fetchBlockingRelationships).toHaveBeenCalledWith("org/repo", [10, 11]);
    expect(res.body.items[0].issue.blockedBy).toEqual([{ number: 5, title: "Blocker issue" }]);
    expect(res.body.items[1].issue.blockedBy).toEqual([]);
  });

  it("enriches project items with blockedBy and blockingCount when enforcement is enabled", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      benches: { autoClear: true, enforceIssueDependencies: true },
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [{ issue: { number: 1, title: "Task A" } }, { issue: { number: 2, title: "Task B" } }],
      projectTitle: "My Project",
    } as any);
    vi.mocked(githubService.fetchBlockingRelationships).mockResolvedValue({
      blockedBy: { 1: [{ number: 3, title: "Blocker" }], 2: [] },
      blockingCount: { 1: 0, 2: 3 },
    });

    const res = await request(app).get("/project1/project-items?project=1");
    expect(res.status).toBe(200);
    expect(githubService.fetchBlockingRelationships).toHaveBeenCalledWith("org/repo", [1, 2]);
    expect(res.body.items[0].issue.blockedBy).toEqual([{ number: 3, title: "Blocker" }]);
    expect(res.body.items[0].issue.blockingCount).toBe(0);
    expect(res.body.items[1].issue.blockedBy).toEqual([]);
    expect(res.body.items[1].issue.blockingCount).toBe(3);
    expect(res.body.projectTitle).toBe("My Project");
  });

  it("returns 500 when fetchBlockingRelationships throws during enrichment", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      benches: { autoClear: true, enforceIssueDependencies: true },
    });
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: { project: { repo: "org/repo" } },
    } as any);
    vi.mocked(githubService.fetchProjectItems).mockResolvedValue({
      items: [{ issue: { number: 1, title: "Task" } }],
      projectTitle: "P",
    } as any);
    vi.mocked(githubService.fetchBlockingRelationships).mockRejectedValue(
      new Error("graphql exploded"),
    );

    const res = await request(app).get("/project1/project-items?project=1");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("graphql exploded");
  });
});
