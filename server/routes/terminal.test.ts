import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/terminal.js", () => ({
  createSession: vi.fn(),
  getSessions: vi.fn(),
  destroySession: vi.fn(),
  writeToSession: vi.fn(),
}));
vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
}));
vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));
vi.mock("../services/jig-manager.js", () => ({
  getJig: vi.fn(),
  getDefaultJigId: vi.fn(),
  resolveJigContent: vi.fn(),
}));
vi.mock("../services/config-parser.js", () => ({
  buildTemplateContext: vi.fn().mockReturnValue({
    ports: {},
    portHttps: {},
    workspace: "/workspace",
    components: {},
  }),
  applyContainerOverrides: vi.fn(),
}));
vi.mock("../services/state.js", () => ({
  loadSettings: vi.fn().mockReturnValue({
    jigs: {
      autoInject: true,
      autoExecute: true,
      defaultJigId: "feature-dev",
    },
  }),
  getProjectPermissions: vi.fn().mockReturnValue({ allow: [], deny: [] }),
}));
vi.mock("../services/issue-formatting.js", () => ({
  fetchIssueContext: vi.fn(),
}));
vi.mock("../services/notification.js", () => ({
  createNotification: vi.fn(),
}));

import router from "./terminal.js";
import * as terminalService from "../services/terminal.js";
import * as benchManager from "../services/bench-manager.js";
import * as notificationService from "../services/notification.js";
import * as projectRegistry from "../services/project-registry.js";
import * as jigManager from "../services/jig-manager.js";
import * as state from "../services/state.js";
import * as issueFormatting from "../services/issue-formatting.js";

const app = express();
app.use(express.json());
app.use("/", router);

const MOCK_BENCH = {
  id: 1,
  projectId: "project1",
  workspacePath: "/workspace",
  branch: "feature/test",
  assignedContainers: {},
};

const MOCK_BENCH_WITH_ISSUE = {
  ...MOCK_BENCH,
  assignedIssue: { number: 42, title: "Fix the widget" },
};

const MOCK_PROJECT = {
  config: {
    project: { name: "project", displayName: "My Project", repo: "owner/repo" },
    components: {},
  },
  repoPath: "/repo",
};

const MOCK_JIG = {
  id: "push",
  name: "Push & Merge",
  description: "Push and merge",
  icon: "git-pull-request",
  source: "app",
  content: "Push {{bench.branch}} to GitHub",
  sizeBytes: 50,
  sizeWarning: false,
};

describe("invalid bench id", () => {
  it("returns 400 for non-numeric bench id on POST", async () => {
    const res = await request(app).post("/project1/benches/abc/terminals").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 400 for non-numeric bench id on GET", async () => {
    const res = await request(app).get("/project1/benches/abc/terminals");
    expect(res.status).toBe(400);
  });
});

describe("POST /:projectId/benches/:id/terminals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Terminal 1 - My Project #1",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "live",
    });
    vi.mocked(terminalService.writeToSession).mockReturnValue(true);
    vi.mocked(state.loadSettings).mockReturnValue({
      jigs: {
        autoInject: true,
        autoExecute: true,
        defaultJigId: "feature-dev",
      },
    });
  });

  it("returns 404 when bench not found", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).post("/project1/benches/1/terminals").send({});
    expect(res.status).toBe(404);
  });

  it("creates a terminal session", async () => {
    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude" });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sessionId: "term-1",
      label: "Terminal 1 - My Project #1",
      wsUrl: "/ws/terminal/term-1",
    });
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      undefined,
      undefined,
      { allow: [], deny: [] },
      expect.any(Function),
    );
  });

  it("returns 400 for invalid jigId", async () => {
    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "../evil" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid jig id/i);
  });

  it("resolves GLOBAL_DEFAULT_JIG_ID sentinel to configured default jig", async () => {
    vi.mocked(jigManager.getDefaultJigId).mockReturnValue("push");
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Push jig content");

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "__global_default__" });

    expect(res.status).toBe(201);
    expect(jigManager.getDefaultJigId).toHaveBeenCalledWith("project1");
    expect(jigManager.getJig).toHaveBeenCalledWith("project1", "push");
  });

  it("injects embedded global default when GLOBAL_DEFAULT_JIG_ID sentinel has no override configured", async () => {
    vi.mocked(jigManager.getDefaultJigId).mockReturnValue("__global_default__");
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Default jig content");

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "__global_default__" });

    expect(res.status).toBe(201);
    expect(jigManager.getJig).toHaveBeenCalledWith("project1", "__global_default__");
    expect(res.body.jigInjected).toBe(true);
  });

  it("returns 404 when jigId is provided but jig not found", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(null);

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "push" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/jig not found/i);
  });

  it("passes resolved jig as initialInput when autoExecute is true", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Push feature/test to GitHub");

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      "Push feature/test to GitHub",
      undefined,
      { allow: [], deny: [] },
      expect.any(Function),
    );
  });

  it("does not pass initialInput when autoExecute is false, schedules PTY write instead", async () => {
    vi.useFakeTimers();
    vi.mocked(state.loadSettings).mockReturnValue({
      jigs: {
        autoInject: true,
        autoExecute: false,
        defaultJigId: "feature-dev",
      },
    });
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Push feature/test to GitHub");

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigScheduled).toBe(true);
    expect(res.body.jigInjected).toBeUndefined();
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      undefined,
      undefined,
      { allow: [], deny: [] },
      expect.any(Function),
    );
    expect(terminalService.writeToSession).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(terminalService.writeToSession).toHaveBeenCalledWith(
      "term-1",
      "Push feature/test to GitHub",
    );
    vi.useRealTimers();
  });

  it("ignores jigId for non-claude commands", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.status).toBe(201);
    expect(jigManager.getJig).not.toHaveBeenCalled();
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("forwards claudeCode settings from loadSettings to createSession", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({
      jigs: {
        autoInject: true,
        autoExecute: true,
        defaultJigId: "feature-dev",
      },
      claudeCode: { enableAutoMode: true, startInPlanMode: false },
    });

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude" });

    expect(res.status).toBe(201);
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      undefined,
      { enableAutoMode: true, startInPlanMode: false },
      { allow: [], deny: [] },
      expect.any(Function),
    );
  });

  it("fetches and passes project permissions to createSession for claude command", async () => {
    vi.mocked(state.getProjectPermissions).mockReturnValue({
      allow: ["Bash(npm test:*)", "Bash(npx vitest:*)"],
      deny: [],
    });

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude" });

    expect(res.status).toBe(201);
    expect(state.getProjectPermissions).toHaveBeenCalledWith("project1");
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      "claude",
      undefined,
      undefined,
      { allow: ["Bash(npm test:*)", "Bash(npx vitest:*)"], deny: [] },
      expect.any(Function),
    );
  });

  it("does not fetch project permissions for non-claude commands", async () => {
    const res = await request(app).post("/project1/benches/1/terminals").send({});

    expect(res.status).toBe(201);
    expect(state.getProjectPermissions).not.toHaveBeenCalled();
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("fetches issue context when bench has assigned issue", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH_WITH_ISSUE as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Resolved");
    vi.mocked(issueFormatting.fetchIssueContext).mockResolvedValue({
      issueNumber: 42,
      issueTitle: "Fix the widget",
      issueBody: "It is broken.",
      issueUrl: "https://github.com/owner/repo/issues/42",
      comments: "",
    });

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "push" });

    expect(res.status).toBe(201);
    expect(issueFormatting.fetchIssueContext).toHaveBeenCalledWith("owner/repo", 42);
    expect(jigManager.resolveJigContent).toHaveBeenCalledWith(
      MOCK_JIG.content,
      expect.objectContaining({
        issueNumber: 42,
        issueTitle: "Fix the widget",
      }),
    );
  });

  it("skips jig injection silently when project has no config", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue({
      config: undefined,
    } as unknown as ReturnType<typeof projectRegistry.getProject>);

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBeUndefined();
    expect(res.body.jigScheduled).toBeUndefined();
    expect(jigManager.getJig).not.toHaveBeenCalled();
  });

  it("includes sizeWarning in response when jig sizeWarning is true", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue({
      ...MOCK_JIG,
      sizeWarning: true,
    } as unknown as ReturnType<typeof jigManager.getJig>);
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Very large jig content");

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    expect(res.body.sizeWarning).toBe(true);
  });

  it("falls back to minimal issue data when GitHub fetch fails", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH_WITH_ISSUE as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Resolved");
    vi.mocked(issueFormatting.fetchIssueContext).mockRejectedValue(new Error("GitHub API error"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude", jigId: "push" });

    expect(res.status).toBe(201);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to fetch issue #42"));
    expect(jigManager.resolveJigContent).toHaveBeenCalledWith(
      MOCK_JIG.content,
      expect.objectContaining({
        issueNumber: 42,
        issueTitle: "Fix the widget",
      }),
    );
    warnSpy.mockRestore();
  });

  it("onClaudeExit callback calls createNotification with the bench and claude-exited type", async () => {
    await request(app).post("/project1/benches/1/terminals").send({ command: "claude" });

    const onClaudeExit = vi.mocked(terminalService.createSession).mock.calls[0][8] as (
      sessionId: string,
    ) => void;
    onClaudeExit("term-1");

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      MOCK_BENCH,
      "claude-exited",
      "term-1",
    );
  });
});

describe("GET /:projectId/benches/:id/terminals", () => {
  it("returns sessions for a bench", async () => {
    const sessions = [
      {
        id: "term-1",
        benchKey: "project1:1",
        label: "Terminal 1",
        createdAt: "2026-01-01",
        status: "live" as const,
      },
    ];
    vi.mocked(terminalService.getSessions).mockReturnValue(sessions);

    const res = await request(app).get("/project1/benches/1/terminals");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sessions);
    expect(terminalService.getSessions).toHaveBeenCalledWith("project1", 1);
  });
});

describe("DELETE /:projectId/benches/:id/terminals/:sid", () => {
  it("returns 204 when session is destroyed", async () => {
    vi.mocked(terminalService.destroySession).mockReturnValue(true);

    const res = await request(app).delete("/project1/benches/1/terminals/term-1");
    expect(res.status).toBe(204);
  });

  it("returns 404 when session not found", async () => {
    vi.mocked(terminalService.destroySession).mockReturnValue(false);

    const res = await request(app).delete("/project1/benches/1/terminals/nonexistent");
    expect(res.status).toBe(404);
  });
});
