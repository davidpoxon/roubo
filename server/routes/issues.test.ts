import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { NormalizedIssue } from "@roubo/shared";
import { ServiceError } from "../services/service-error.js";

vi.mock("../services/plugin-manager.js", () => ({
  invoke: vi.fn(),
}));

vi.mock("../services/active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(),
}));

vi.mock("../services/issue-assignment.js", () => ({
  assignIssue: vi.fn(),
  unassignIssue: vi.fn(),
}));

import router from "./issues.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as activePlugin from "../services/active-plugin.js";
import * as issueAssignment from "../services/issue-assignment.js";

const app = express();
app.use(express.json());
app.use("/", router);

function makeIssue(overrides: Partial<NormalizedIssue>): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId: "1",
    externalUrl: "https://github.com/org/repo/issues/1",
    title: "Test issue",
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2024-01-01T00:00:00Z",
    raw: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue({
    pluginId: "github-com",
    integrationId: "github-com",
    pageSize: 50,
  });
});

describe("GET /:projectId/issues", () => {
  it("returns 503 when no active integration plugin is configured", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no-active-integration");
  });

  it("calls the plugin's listIssues with the resolved pageSize and forwarded filters", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({ items: [], nextCursor: null });
    await request(app).get("/p1/issues?cursor=c1&labels=bug,feature&search=login");
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "listIssues", {
      cursor: "c1",
      pageSize: 50,
      filters: { labels: ["bug", "feature"], search: "login" },
    });
  });

  it("returns the paginated body with items and nextCursor", async () => {
    const issues = [makeIssue({ externalId: "1" }), makeIssue({ externalId: "2" })];
    vi.mocked(pluginManager.invoke).mockResolvedValue({ items: issues, nextCursor: "next" });
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBe("next");
    expect(res.body.stalled).toBeUndefined();
  });

  it("dedupes items within a page by (integrationId, externalId) (TC-023)", async () => {
    const a = makeIssue({ externalId: "10" });
    const b = makeIssue({ externalId: "10" });
    const c = makeIssue({ externalId: "11" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({ items: [a, b, c], nextCursor: "n2" });
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((i: NormalizedIssue) => i.externalId)).toEqual(["10", "11"]);
  });

  it("marks the response stalled when the plugin echoes back the request cursor (TC-071)", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [makeIssue({ externalId: "1" })],
      nextCursor: "same",
    });
    const res = await request(app).get("/p1/issues?cursor=same");
    expect(res.body.stalled).toBe(true);
    expect(res.body.nextCursor).toBeNull();
  });

  it("does NOT mark stalled when the cursor changes, even if the new page repeats items", async () => {
    const dup = makeIssue({ externalId: "5" });
    vi.mocked(pluginManager.invoke).mockResolvedValue({
      items: [dup, dup, dup],
      nextCursor: "different",
    });
    const res = await request(app).get("/p1/issues?cursor=before");
    expect(res.body.stalled).toBeUndefined();
    expect(res.body.nextCursor).toBe("different");
    // Items are still deduped within the page.
    expect(res.body.items).toHaveLength(1);
  });

  it("maps plugin-not-enabled to 503", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(
      Object.assign(new Error("disabled"), { code: "plugin-not-enabled" }),
    );
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("plugin-not-enabled");
  });

  it("maps timeout to 504", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(
      Object.assign(new Error("timed out"), { code: "timeout" }),
    );
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(504);
  });

  it("maps unknown rpc errors to 502", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("boom"));
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(502);
  });

  it("honors a per-request pageSize override", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue({ items: [], nextCursor: null });
    await request(app).get("/p1/issues?pageSize=25");
    expect(pluginManager.invoke).toHaveBeenCalledWith(
      "github-com",
      "listIssues",
      expect.objectContaining({ pageSize: 25 }),
    );
  });
});

describe("GET /:projectId/issues/:externalId", () => {
  it("returns 503 when no active integration", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app).get("/p1/issues/42");
    expect(res.status).toBe(503);
  });

  it("invokes getIssue with the URL externalId and returns the NormalizedIssue", async () => {
    const issue = makeIssue({ externalId: "ROUBO-42", title: "Detail" });
    vi.mocked(pluginManager.invoke).mockResolvedValue(issue);
    const res = await request(app).get("/p1/issues/ROUBO-42");
    expect(res.status).toBe(200);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "ROUBO-42",
    });
    expect(res.body).toEqual(issue);
  });
});

describe("POST /:projectId/issues/:externalId/transitions", () => {
  it("returns 503 when no active integration", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/transitions")
      .send({ transitionName: "Done" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no-active-integration");
  });

  it("returns 400 when transitionName is missing", async () => {
    const res = await request(app).post("/p1/issues/ROUBO-42/transitions").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when transitionName is not a string", async () => {
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/transitions")
      .send({ transitionName: 123 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when transitionName is an empty string", async () => {
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/transitions")
      .send({ transitionName: "" });
    expect(res.status).toBe(400);
  });

  it("invokes applyTransition with externalId + transitionName and returns the refreshed issue (TC-054)", async () => {
    const refreshed = makeIssue({
      externalId: "ROUBO-42",
      currentState: "In Review",
      allowedTransitions: ["Done"],
    });
    vi.mocked(pluginManager.invoke).mockResolvedValue(refreshed);
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/transitions")
      .send({ transitionName: "In Review" });
    expect(res.status).toBe(200);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "applyTransition", {
      externalId: "ROUBO-42",
      transitionName: "In Review",
    });
    expect(res.body).toEqual(refreshed);
  });

  it("forwards a structured plugin error verbatim with 502 (TC-063)", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(
      Object.assign(new Error("Your token lacks permission to transition this workflow."), {
        code: "rpc-error",
      }),
    );
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/transitions")
      .send({ transitionName: "Done" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "rpc-error",
      message: "Your token lacks permission to transition this workflow.",
    });
  });

  it("maps timeout to 504", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(
      Object.assign(new Error("timed out"), { code: "timeout" }),
    );
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/transitions")
      .send({ transitionName: "Done" });
    expect(res.status).toBe(504);
  });
});

describe("GET /:projectId/issues/:externalId/comments", () => {
  it("invokes getComments and returns NormalizedComment[]", async () => {
    const comments = [
      {
        externalId: "c-1",
        author: { externalId: "u-1", displayName: "Alice" },
        body: "hi",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ];
    vi.mocked(pluginManager.invoke).mockResolvedValue(comments);
    const res = await request(app).get("/p1/issues/1/comments");
    expect(res.status).toBe(200);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getComments", {
      externalId: "1",
    });
    expect(res.body).toEqual(comments);
  });

  it("returns 503 when no active integration", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app).get("/p1/issues/1/comments");
    expect(res.status).toBe(503);
  });
});

describe("GET /:projectId/labels", () => {
  it("invokes listLabels and returns the string list", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue(["bug", "feature"]);
    const res = await request(app).get("/p1/labels");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(["bug", "feature"]);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "listLabels", {});
  });

  it("returns 503 when no active integration", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app).get("/p1/labels");
    expect(res.status).toBe(503);
  });
});

describe("POST /:projectId/benches/:id/assign-issue", () => {
  it("assigns an issue to a bench (legacy issueNumber contract preserved)", async () => {
    vi.mocked(issueAssignment.assignIssue).mockResolvedValue({
      bench: { id: 1 },
      terminalSessionId: "term-1",
    } as never);
    const res = await request(app).post("/p1/benches/1/assign-issue").send({ issueNumber: 42 });
    expect(res.status).toBe(200);
    expect(issueAssignment.assignIssue).toHaveBeenCalledWith("p1", 1, 42);
  });

  it("returns 400 when issueNumber is missing", async () => {
    const res = await request(app).post("/p1/benches/1/assign-issue").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-numeric bench id", async () => {
    const res = await request(app).post("/p1/benches/abc/assign-issue").send({ issueNumber: 1 });
    expect(res.status).toBe(400);
  });

  it("forwards ServiceError status from the assignment service", async () => {
    vi.mocked(issueAssignment.assignIssue).mockRejectedValue(
      new ServiceError(404, "Bench not found"),
    );
    const res = await request(app).post("/p1/benches/1/assign-issue").send({ issueNumber: 1 });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /:projectId/benches/:id/assign-issue", () => {
  it("unassigns the issue", async () => {
    vi.mocked(issueAssignment.unassignIssue).mockResolvedValue({ id: 1 } as never);
    const res = await request(app).delete("/p1/benches/1/assign-issue");
    expect(res.status).toBe(200);
  });

  it("returns 400 for a non-numeric bench id", async () => {
    const res = await request(app).delete("/p1/benches/abc/assign-issue");
    expect(res.status).toBe(400);
  });
});
