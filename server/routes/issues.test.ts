import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { NormalizedIssue } from "@roubo/shared";
import { ServiceError } from "../services/service-error.js";

vi.mock("../services/plugin-manager.js", () => ({
  invoke: vi.fn(),
  getRecord: vi.fn(),
}));

vi.mock("../services/issue-snapshot-cache.js", () => ({
  getSnapshot: vi.fn(),
  recordSnapshot: vi.fn(),
}));

vi.mock("../services/cut-list-query-service.js", () => ({
  cutListQueryService: {
    queryFirstOrPage: vi.fn(),
    buildListParams: vi.fn(),
  },
}));

vi.mock("../services/active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(),
}));

vi.mock("../services/plugin-activation.js", () => ({
  ensurePluginActivated: vi.fn().mockResolvedValue(undefined),
  forgetProjectActivation: vi.fn(),
  forgetPluginActivation: vi.fn(),
  resolveSources: vi.fn().mockReturnValue([{ kind: "repo", externalId: "foo/bar" }]),
  resolveExclusion: vi.fn().mockReturnValue({ excludedStatusCategories: [], excludedStatuses: [] }),
  resolveInstanceEndpoint: vi.fn().mockReturnValue(null),
}));

vi.mock("../services/integration-migrations.js", () => ({
  awaitPendingIntegrationSetup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/issue-assignment.js", () => ({
  assignIssue: vi.fn(),
  unassignIssue: vi.fn(),
}));

import router from "./issues.js";
import * as pluginManager from "../services/plugin-manager.js";
import * as activePlugin from "../services/active-plugin.js";
import * as pluginActivation from "../services/plugin-activation.js";
import * as issueAssignment from "../services/issue-assignment.js";
import * as issueSnapshotCache from "../services/issue-snapshot-cache.js";
import * as integrationMigrations from "../services/integration-migrations.js";
import { cutListQueryService } from "../services/cut-list-query-service.js";

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
  vi.mocked(pluginActivation.ensurePluginActivated).mockResolvedValue(undefined);
  vi.mocked(pluginActivation.resolveSources).mockReturnValue([
    { kind: "repo", externalId: "foo/bar" },
  ]);
  vi.mocked(pluginActivation.resolveExclusion).mockReturnValue({
    excludedStatusCategories: [],
    excludedStatuses: [],
  });
  vi.mocked(integrationMigrations.awaitPendingIntegrationSetup).mockResolvedValue(undefined);
  // Default: the cut-list service returns an empty first page. The route's
  // in-memory fallback path calls buildListParams to re-derive the cache key.
  vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
    items: [],
    nextCursor: null,
    cacheStatus: "miss",
  });
  vi.mocked(cutListQueryService.buildListParams).mockReturnValue({
    sources: [{ kind: "repo", externalId: "foo/bar" }],
    cursor: null,
    pageSize: 50,
    filters: undefined,
    excludedStatusCategories: [],
    excludedStatuses: [],
  });
});

describe("GET /:projectId/issues", () => {
  it("returns 503 when no active integration plugin is configured", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no-active-integration");
  });

  it("returns 502 plugin-activation-failed when ensurePluginActivated rejects", async () => {
    vi.mocked(pluginActivation.ensurePluginActivated).mockRejectedValueOnce(
      new Error("bad config"),
    );
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "plugin-activation-failed",
      message: "bad config",
    });
    expect(cutListQueryService.queryFirstOrPage).not.toHaveBeenCalled();
  });

  it("parses the query string and delegates to the cut-list service", async () => {
    vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
      items: [],
      nextCursor: null,
      cacheStatus: "miss",
    });
    await request(app).get("/p1/issues?cursor=c1&labels=bug,feature&search=login&pageSize=25");
    expect(cutListQueryService.queryFirstOrPage).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({ pluginId: "github-com" }),
      { cursor: "c1", pageSize: 25, filters: { labels: ["bug", "feature"], search: "login" } },
    );
  });

  it("defaults to the active plugin pageSize and a null cursor when unspecified", async () => {
    vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
      items: [],
      nextCursor: null,
      cacheStatus: "miss",
    });
    await request(app).get("/p1/issues");
    expect(cutListQueryService.queryFirstOrPage).toHaveBeenCalledWith("p1", expect.anything(), {
      cursor: null,
      pageSize: 50,
      filters: {},
    });
  });

  it("awaits any pending integration setup before delegating", async () => {
    let releaseSetup!: () => void;
    let delegatedDuringWait = false;
    vi.mocked(integrationMigrations.awaitPendingIntegrationSetup).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseSetup = () => resolve();
      }),
    );
    vi.mocked(cutListQueryService.queryFirstOrPage).mockImplementation(async () => {
      delegatedDuringWait = true;
      return { items: [], nextCursor: null, cacheStatus: "miss" };
    });

    const pending = request(app).get("/p1/issues");
    await new Promise((r) => setImmediate(r));
    expect(delegatedDuringWait).toBe(false);

    releaseSetup();
    await pending;
    expect(delegatedDuringWait).toBe(true);
    expect(integrationMigrations.awaitPendingIntegrationSetup).toHaveBeenCalledWith("p1");
  });

  it("serialises the service result into the response body", async () => {
    const issues = [makeIssue({ externalId: "1" }), makeIssue({ externalId: "2" })];
    vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
      items: issues,
      nextCursor: "next",
      cacheStatus: "miss",
    });
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.nextCursor).toBe("next");
    expect(res.body.stalled).toBeUndefined();
  });

  it("serialises cacheStatus and snapshotCapturedAt onto the body for a warm (revalidating) serve (CLI-FR-002)", async () => {
    vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
      items: [makeIssue({ externalId: "warm" })],
      nextCursor: null,
      snapshotCapturedAt: "2026-06-01T12:00:00.000Z",
      cacheStatus: "revalidating",
    });
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(200);
    expect(res.body.cacheStatus).toBe("revalidating");
    expect(res.body.snapshotCapturedAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("serialises cacheStatus 'miss' without a snapshotCapturedAt on a cold load", async () => {
    vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
      items: [makeIssue({ externalId: "1" })],
      nextCursor: null,
      cacheStatus: "miss",
    });
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(200);
    expect(res.body.cacheStatus).toBe("miss");
    expect(res.body.snapshotCapturedAt).toBeUndefined();
  });

  it("serialises stalled, warnings, and excludedCount when present", async () => {
    const warning = {
      category: "code-scanning",
      sourceExternalId: "foo/bar",
      cause: "Code Scanning unavailable: GHAS not enabled on this repo.",
      detail: { status: 404 },
    };
    vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
      items: [makeIssue({ externalId: "1" })],
      nextCursor: null,
      stalled: true,
      warnings: [warning],
      excludedCount: 3,
      cacheStatus: "miss",
    });
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(200);
    expect(res.body.stalled).toBe(true);
    expect(res.body.warnings).toEqual([warning]);
    expect(res.body.excludedCount).toBe(3);
  });

  it("omits warnings and excludedCount when the service does not report them", async () => {
    vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
      items: [],
      nextCursor: null,
      cacheStatus: "miss",
    });
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(200);
    expect(res.body.warnings).toBeUndefined();
    expect(res.body.excludedCount).toBeUndefined();
  });

  it("maps plugin-not-enabled to 503 when no in-memory fallback applies", async () => {
    vi.mocked(cutListQueryService.queryFirstOrPage).mockRejectedValue(
      Object.assign(new Error("disabled"), { code: "plugin-not-enabled" }),
    );
    vi.mocked(pluginManager.getRecord).mockReturnValue({
      id: "github-com",
      status: "enabled",
    } as unknown as ReturnType<typeof pluginManager.getRecord>);
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("plugin-not-enabled");
    expect(res.body.error).toBe("disabled");
  });

  it("maps timeout to 504", async () => {
    vi.mocked(cutListQueryService.queryFirstOrPage).mockRejectedValue(
      Object.assign(new Error("timed out"), { code: "timeout" }),
    );
    vi.mocked(pluginManager.getRecord).mockReturnValue({
      id: "github-com",
      status: "enabled",
    } as unknown as ReturnType<typeof pluginManager.getRecord>);
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(504);
  });

  it("maps unknown rpc errors to 502", async () => {
    vi.mocked(cutListQueryService.queryFirstOrPage).mockRejectedValue(new Error("boom"));
    vi.mocked(pluginManager.getRecord).mockReturnValue({
      id: "github-com",
      status: "enabled",
    } as unknown as ReturnType<typeof pluginManager.getRecord>);
    const res = await request(app).get("/p1/issues");
    expect(res.status).toBe(502);
  });

  describe("FR-014: last-good in-memory snapshot fallback (TC-163, TC-016)", () => {
    it("records the first page in-memory on success so a later errored fallback has something to serve", async () => {
      vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
        items: [makeIssue({ externalId: "1" })],
        nextCursor: null,
        cacheStatus: "miss",
      });
      vi.mocked(pluginManager.getRecord).mockReturnValue({
        id: "github-com",
        manifest: { name: "GitHub.com", version: "1.0.0" },
      } as unknown as ReturnType<typeof pluginManager.getRecord>);
      await request(app).get("/p1/issues");
      expect(issueSnapshotCache.recordSnapshot).toHaveBeenCalledWith(
        "github-com",
        "p1",
        expect.objectContaining({ sources: [{ kind: "repo", externalId: "foo/bar" }] }),
        expect.objectContaining({
          items: expect.arrayContaining([expect.objectContaining({ externalId: "1" })]),
        }),
        "GitHub.com",
        true,
      );
    });

    it("does not record an in-memory snapshot for paginated requests (cursor != null)", async () => {
      vi.mocked(cutListQueryService.queryFirstOrPage).mockResolvedValue({
        items: [makeIssue({ externalId: "2" })],
        nextCursor: null,
        cacheStatus: "miss",
      });
      await request(app).get("/p1/issues?cursor=page-2");
      expect(issueSnapshotCache.recordSnapshot).not.toHaveBeenCalled();
    });

    it("serves the cached snapshot with stale: true when the plugin is errored and the first page is cached", async () => {
      vi.mocked(cutListQueryService.queryFirstOrPage).mockRejectedValue(
        Object.assign(new Error("not running"), { code: "plugin-not-enabled" }),
      );
      vi.mocked(pluginManager.getRecord).mockReturnValue({
        id: "github-com",
        status: "errored",
      } as unknown as ReturnType<typeof pluginManager.getRecord>);
      const cachedItems = [makeIssue({ externalId: "cached-1", title: "from cache" })];
      vi.mocked(issueSnapshotCache.getSnapshot).mockReturnValue({
        response: { items: cachedItems, nextCursor: null },
        capturedAt: "2026-05-27T09:00:00.000Z",
        pluginName: "GitHub.com",
      });
      const res = await request(app).get("/p1/issues");
      expect(res.status).toBe(200);
      expect(res.body.stale).toBe(true);
      expect(res.body.snapshotCapturedAt).toBe("2026-05-27T09:00:00.000Z");
      expect(res.body.items[0].externalId).toBe("cached-1");
    });

    it("also serves the cached snapshot while the plugin is disabled", async () => {
      vi.mocked(cutListQueryService.queryFirstOrPage).mockRejectedValue(
        Object.assign(new Error("not running"), { code: "plugin-not-enabled" }),
      );
      vi.mocked(pluginManager.getRecord).mockReturnValue({
        id: "github-com",
        status: "disabled",
      } as unknown as ReturnType<typeof pluginManager.getRecord>);
      vi.mocked(issueSnapshotCache.getSnapshot).mockReturnValue({
        response: { items: [], nextCursor: null },
        capturedAt: "2026-05-27T09:00:00.000Z",
        pluginName: "GitHub.com",
      });
      const res = await request(app).get("/p1/issues");
      expect(res.status).toBe(200);
      expect(res.body.stale).toBe(true);
    });

    it("falls through to the existing 503 when the plugin is errored but no snapshot is cached", async () => {
      vi.mocked(cutListQueryService.queryFirstOrPage).mockRejectedValue(
        Object.assign(new Error("not running"), { code: "plugin-not-enabled" }),
      );
      vi.mocked(pluginManager.getRecord).mockReturnValue({
        id: "github-com",
        status: "errored",
      } as unknown as ReturnType<typeof pluginManager.getRecord>);
      vi.mocked(issueSnapshotCache.getSnapshot).mockReturnValue(undefined);
      const res = await request(app).get("/p1/issues");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("plugin-not-enabled");
    });

    it("does not serve the cached snapshot on paginated requests (cursor > 0)", async () => {
      vi.mocked(cutListQueryService.queryFirstOrPage).mockRejectedValue(
        Object.assign(new Error("not running"), { code: "plugin-not-enabled" }),
      );
      vi.mocked(pluginManager.getRecord).mockReturnValue({
        id: "github-com",
        status: "errored",
      } as unknown as ReturnType<typeof pluginManager.getRecord>);
      vi.mocked(issueSnapshotCache.getSnapshot).mockReturnValue({
        response: { items: [makeIssue({ externalId: "cached-1" })], nextCursor: null },
        capturedAt: "2026-05-27T09:00:00.000Z",
        pluginName: "GitHub.com",
      });
      const res = await request(app).get("/p1/issues?cursor=page-2");
      expect(res.status).toBe(503);
      expect(issueSnapshotCache.getSnapshot).not.toHaveBeenCalled();
    });

    it("does not serve the snapshot when the plugin is enabled (real error should surface)", async () => {
      vi.mocked(cutListQueryService.queryFirstOrPage).mockRejectedValue(
        Object.assign(new Error("rpc broke"), { code: "rpc-error" }),
      );
      vi.mocked(pluginManager.getRecord).mockReturnValue({
        id: "github-com",
        status: "enabled",
      } as unknown as ReturnType<typeof pluginManager.getRecord>);
      vi.mocked(issueSnapshotCache.getSnapshot).mockReturnValue({
        response: { items: [makeIssue({ externalId: "cached-1" })], nextCursor: null },
        capturedAt: "2026-05-27T09:00:00.000Z",
        pluginName: "GitHub.com",
      });
      const res = await request(app).get("/p1/issues");
      expect(res.status).toBe(502);
      expect(issueSnapshotCache.getSnapshot).not.toHaveBeenCalled();
    });
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
      error: "Your token lacks permission to transition this workflow.",
      code: "rpc-error",
      params: {},
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

describe("POST /:projectId/issues/:externalId/assign", () => {
  it("returns 503 when no active integration", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/assign")
      .send({ assigneeExternalId: "jane.doe@acme.com" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("no-active-integration");
  });

  it("returns 400 when assigneeExternalId is missing", async () => {
    const res = await request(app).post("/p1/issues/ROUBO-42/assign").send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 when assigneeExternalId is not a string", async () => {
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/assign")
      .send({ assigneeExternalId: 123 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when assigneeExternalId is an empty string", async () => {
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/assign")
      .send({ assigneeExternalId: "" });
    expect(res.status).toBe(400);
  });

  it("invokes plugin.assignIssue with externalId + assigneeExternalId and returns 204 (TC-040)", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue(undefined);
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/assign")
      .send({ assigneeExternalId: "jane.doe@acme.com" });
    expect(res.status).toBe(204);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "assignIssue", {
      externalId: "ROUBO-42",
      assigneeExternalId: "jane.doe@acme.com",
    });
    expect(res.text).toBe("");
  });

  it("forwards a structured plugin error verbatim with 502", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(
      Object.assign(new Error("Your token lacks permission to assign issues."), {
        code: "rpc-error",
      }),
    );
    const res = await request(app)
      .post("/p1/issues/ROUBO-42/assign")
      .send({ assigneeExternalId: "jane.doe@acme.com" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "Your token lacks permission to assign issues.",
      code: "rpc-error",
      params: {},
    });
  });
});

describe("DELETE /:projectId/issues/:externalId/assign", () => {
  it("returns 503 when no active integration", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app)
      .delete("/p1/issues/ROUBO-42/assign")
      .send({ assigneeExternalId: "jane.doe@acme.com" });
    expect(res.status).toBe(503);
  });

  it("returns 400 when assigneeExternalId is missing", async () => {
    const res = await request(app).delete("/p1/issues/ROUBO-42/assign").send({});
    expect(res.status).toBe(400);
  });

  it("invokes plugin.unassignIssue with externalId + assigneeExternalId and returns 204", async () => {
    vi.mocked(pluginManager.invoke).mockResolvedValue(undefined);
    const res = await request(app)
      .delete("/p1/issues/ROUBO-42/assign")
      .send({ assigneeExternalId: "jane.doe@acme.com" });
    expect(res.status).toBe(204);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "unassignIssue", {
      externalId: "ROUBO-42",
      assigneeExternalId: "jane.doe@acme.com",
    });
  });

  it("forwards a structured plugin error verbatim with 502", async () => {
    vi.mocked(pluginManager.invoke).mockRejectedValue(
      Object.assign(new Error("Plugin refused unassign"), { code: "rpc-error" }),
    );
    const res = await request(app)
      .delete("/p1/issues/ROUBO-42/assign")
      .send({ assigneeExternalId: "jane.doe@acme.com" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: "Plugin refused unassign",
      code: "rpc-error",
      params: {},
    });
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
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "listLabels", {
      sources: [{ kind: "repo", externalId: "foo/bar" }],
    });
  });

  it("returns 503 when no active integration", async () => {
    vi.mocked(activePlugin.resolveActivePlugin).mockReturnValue(null);
    const res = await request(app).get("/p1/labels");
    expect(res.status).toBe(503);
  });
});

describe("POST /:projectId/benches/:id/assign-issue", () => {
  it("resolves the issue + comments via the plugin and assigns it to a bench", async () => {
    const issue = makeIssue({ externalId: "ROUBO-42", title: "Detail" });
    vi.mocked(pluginManager.invoke).mockImplementation(((_id: string, method: string) =>
      method === "getComments"
        ? Promise.resolve([
            { author: { externalId: "alice", displayName: "Alice" }, body: "looks good" },
          ])
        : Promise.resolve(issue)) as never);
    vi.mocked(issueAssignment.assignIssue).mockResolvedValue({
      bench: { id: 1 },
      terminalSessionId: "term-1",
    } as never);

    const res = await request(app)
      .post("/p1/benches/1/assign-issue")
      .send({ externalId: "ROUBO-42" });

    expect(res.status).toBe(200);
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "ROUBO-42",
    });
    expect(issueAssignment.assignIssue).toHaveBeenCalledWith("p1", 1, issue, [
      { user: "Alice", body: "looks good" },
    ]);
  });

  it("returns 400 when externalId is missing", async () => {
    const res = await request(app).post("/p1/benches/1/assign-issue").send({});
    expect(res.status).toBe(400);
    expect(issueAssignment.assignIssue).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-numeric bench id", async () => {
    const res = await request(app)
      .post("/p1/benches/abc/assign-issue")
      .send({ externalId: "ROUBO-1" });
    expect(res.status).toBe(400);
  });

  it("forwards ServiceError status from the assignment service", async () => {
    vi.mocked(pluginManager.invoke).mockImplementation(((_id: string, method: string) =>
      method === "getComments" ? Promise.resolve([]) : Promise.resolve(makeIssue({}))) as never);
    vi.mocked(issueAssignment.assignIssue).mockRejectedValue(
      new ServiceError(404, "Bench not found"),
    );
    const res = await request(app)
      .post("/p1/benches/1/assign-issue")
      .send({ externalId: "ROUBO-1" });
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
