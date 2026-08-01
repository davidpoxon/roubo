import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/terminal.js", () => ({
  createSession: vi.fn(),
  createAgentSession: vi.fn(),
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
// Partial mock: the error classes stay real (the route matches on them with
// `instanceof`), only the launch-agent resolution is stubbed. Its own order
// semantics are covered in agent-launch-pipeline.test.ts; what matters here is
// the wiring. The default is "no agent resolved", which since #521 is a launch
// failure rather than a fall-through.
const pipelineMocks = vi.hoisted(() => ({
  resolveLaunchAgentId: vi.fn<() => string | undefined>(() => undefined),
}));
vi.mock("../services/agent-launch-pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-launch-pipeline.js")>();
  return { ...actual, resolveLaunchAgentId: pipelineMocks.resolveLaunchAgentId };
});
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
import { AgentUnavailableError } from "../services/agent-launch-pipeline.js";
import { AgentDescriptorError } from "../services/agent-launch-executor.js";
import { AgentLaunchFailureError } from "../services/agent-launch-failure.js";

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

type AgentSession = Awaited<ReturnType<typeof terminalService.createAgentSession>>["session"];

const AGENT_SESSION: AgentSession = {
  id: "term-agent-1",
  benchKey: "project1:1",
  label: "Acme 1 - My Project #1",
  createdAt: "2026-01-01T00:00:00.000Z",
  command: "acme",
  status: "live",
  agentPluginId: "acme-agent",
};

/**
 * Prime `createAgentSession` the way a real launch behaves: an agent that
 * declares `argv-positional` injection reports the prompt as injected exactly
 * when the launch carried one. `mode: "none"` models an agent that declares no
 * injection capability at all (AP-TC-063).
 */
function mockAgentLaunch(
  session: AgentSession,
  mode: "argv-positional" | "none" = "argv-positional",
) {
  vi.mocked(terminalService.createAgentSession).mockImplementation((opts) =>
    Promise.resolve({
      session,
      promptInjection: {
        mode,
        injected: mode !== "none" && opts.initialInput !== undefined,
      },
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

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
    // Since #521 a jig only ever drives an agent launch, so these cases resolve
    // an agent and go down the plugin path. The built-in they used to take is
    // gone (AP-TC-103).
    pipelineMocks.resolveLaunchAgentId.mockReturnValue("acme-agent");
    mockAgentLaunch(AGENT_SESSION);
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

  it("returns 400 and does not spawn for a blank-workspace-path bench (allowlist-rejected)", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({
      ...MOCK_BENCH,
      workspacePath: "",
    } as unknown as ReturnType<typeof benchManager.getBench>);

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no valid workspace path/i);
    // Nothing may be spawned with cwd="" (the server's own working directory).
    expect(terminalService.createSession).not.toHaveBeenCalled();
    expect(terminalService.createAgentSession).not.toHaveBeenCalled();
  });

  it("creates a plain shell terminal when nothing asks for an agent", async () => {
    const res = await request(app).post("/project1/benches/1/terminals").send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sessionId: "term-1",
      label: "Terminal 1 - My Project #1",
      wsUrl: "/ws/terminal/term-1",
    });
    // Four arguments and no more: core assembles no agent argv and passes no
    // agent settings (AP-TC-103, AP-TC-104).
    expect(terminalService.createSession).toHaveBeenCalledWith(
      "project1",
      1,
      "/workspace",
      "My Project",
    );
    expect(terminalService.createAgentSession).not.toHaveBeenCalled();
  });

  it("fails a legacy command-carrier launch with actionable guidance (AP-TC-103)", async () => {
    pipelineMocks.resolveLaunchAgentId.mockReturnValue(undefined);

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ command: "claude" });

    // No silent fallback to a shell, and no built-in launch: a 409 naming the
    // way out.
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no ai coding agent is available/i);
    expect(res.body.error).toMatch(/ai agents/i);
    expect(terminalService.createSession).not.toHaveBeenCalled();
    expect(terminalService.createAgentSession).not.toHaveBeenCalled();
  });

  it("fails a jig-driven launch that resolves no agent, rather than dropping the jig", async () => {
    pipelineMocks.resolveLaunchAgentId.mockReturnValue(undefined);
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Push feature/test to GitHub");

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no ai coding agent is available/i);
    expect(terminalService.createSession).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid jigId", async () => {
    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "../evil" });
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
      .send({ jigId: "__global_default__" });

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
      .send({ jigId: "__global_default__" });

    expect(res.status).toBe(201);
    expect(jigManager.getJig).toHaveBeenCalledWith("project1", "__global_default__");
    expect(res.body.jigInjected).toBe(true);
  });

  it("returns 404 when jigId is provided but jig not found", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(null);

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/jig not found/i);
  });

  it("passes resolved jig as initialInput when autoExecute is true", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Push feature/test to GitHub");

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    expect(terminalService.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project1",
        benchId: 1,
        workspacePath: "/workspace",
        projectName: "My Project",
        agentPluginId: "acme-agent",
        initialInput: "Push feature/test to GitHub",
      }),
    );
  });

  it("re-hydrates alert-backed benches from persisted raw without fetching by number", async () => {
    const alertBench = {
      ...MOCK_BENCH,
      assignedIssue: {
        number: 117,
        integrationId: "github-com",
        externalId: "owner/repo#code-scanning-117",
        title: "SQL injection",
        issueType: "security-code-scanning",
        raw: {
          html_url: "https://github.com/owner/repo/security/code-scanning/117",
          rule: { description: "SQL injection", security_severity_level: "high" },
          most_recent_instance: { location: { path: "src/db.ts", start_line: 12 } },
        },
      },
    };
    vi.mocked(benchManager.getBench).mockReturnValue(
      alertBench as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("resolved");

    await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(issueFormatting.fetchIssueContext).not.toHaveBeenCalled();
    const ctx = vi.mocked(jigManager.resolveJigContent).mock.calls[0][1];
    expect(ctx).toMatchObject({
      issueNumber: 117,
      issueTitle: "SQL injection",
      issueUrl: "https://github.com/owner/repo/security/code-scanning/117",
    });
    expect(ctx.issueBody).toContain("**Location:** src/db.ts:12");
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

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigScheduled).toBe(true);
    expect(res.body.jigInjected).toBeUndefined();
    expect(vi.mocked(terminalService.createAgentSession).mock.calls[0][0]).not.toHaveProperty(
      "initialInput",
    );
    expect(terminalService.writeToSession).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(terminalService.writeToSession).toHaveBeenCalledWith(
      "term-agent-1",
      "Push feature/test to GitHub",
    );
    vi.useRealTimers();
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

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

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

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

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

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

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

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

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

  it("wires the agent-exit notification through the plugin launch, not a command name", async () => {
    await request(app).post("/project1/benches/1/terminals").send({ agentPluginId: "acme-agent" });

    const opts = vi.mocked(terminalService.createAgentSession).mock.calls[0][0];
    opts.onAgentExit?.("term-agent-1");

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      MOCK_BENCH,
      "agent-exited",
      "term-agent-1",
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

describe("POST /:projectId/benches/:id/terminals with agentPluginId (AP-FR-011)", () => {
  const AGENT_SESSION = {
    id: "agent-1",
    benchKey: "project1:1",
    label: "Acme Agent 1 - My Project #1",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "live" as const,
    command: "acme",
    agentPluginId: "acme-agent",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(state.getProjectPermissions).mockReturnValue({
      allow: ["Bash(npm test:*)", "Bash(npx vitest:*)"],
      deny: [],
    });
    mockAgentLaunch(AGENT_SESSION);
  });

  it("routes to the agent pipeline, passing the preset and per-launch layers through", async () => {
    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({
        agentPluginId: "acme-agent",
        presetOverrides: { posture: "auto-edit" },
        perLaunchOverrides: { model: "opus" },
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      sessionId: "agent-1",
      label: "Acme Agent 1 - My Project #1",
      wsUrl: "/ws/terminal/agent-1",
    });
    expect(terminalService.createSession).not.toHaveBeenCalled();
    expect(terminalService.createAgentSession).toHaveBeenCalledWith({
      projectId: "project1",
      benchId: 1,
      workspacePath: "/workspace",
      projectName: "My Project",
      agentPluginId: "acme-agent",
      // AP-FR-016: the project's permissions model travels with every agent
      // launch so the plugin's descriptor can carry it into the workspace.
      permissions: {
        rules: { allow: ["Bash(npm test:*)", "Bash(npx vitest:*)"], ask: [], deny: [] },
      },
      layers: { preset: { posture: "auto-edit" }, perLaunch: { model: "opus" } },
      onAgentExit: expect.any(Function),
    });
  });

  it("onAgentExit callback calls createNotification with the bench and agent-exited type (#646, AP-TC-066)", async () => {
    await request(app).post("/project1/benches/1/terminals").send({ agentPluginId: "acme-agent" });

    const onAgentExit = vi.mocked(terminalService.createAgentSession).mock.calls[0][0]
      .onAgentExit as (sessionId: string) => void;
    onAgentExit("agent-1");

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      MOCK_BENCH,
      "agent-exited",
      "agent-1",
    );
  });

  it("omits an unsupplied layer rather than passing an empty object for it", async () => {
    await request(app).post("/project1/benches/1/terminals").send({ agentPluginId: "acme-agent" });

    expect(terminalService.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ layers: {} }),
    );
  });

  it("still resolves an agent when no agentPluginId is supplied, never a built-in (#521)", async () => {
    await request(app).post("/project1/benches/1/terminals").send({ command: "acme" });

    expect(terminalService.createSession).not.toHaveBeenCalled();
    expect(terminalService.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "acme-agent" }),
    );
  });

  it.each([
    ["not-installed", 404],
    ["not-consented", 403],
    ["incompatible", 409],
    ["not-an-agent", 400],
    ["plugin-unavailable", 503],
  ])("maps a %s agent to %i", async (reason, status) => {
    vi.mocked(terminalService.createAgentSession).mockRejectedValue(
      new AgentUnavailableError({
        reason,
        pluginId: "acme-agent",
        kind: "integration",
        requiredRange: "^9.0.0",
        hostVersion: "1.4.0",
      } as never),
    );

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent" });

    expect(res.status).toBe(status);
    expect(res.body.error).toBeTruthy();
  });

  it("returns 502 for a descriptor core refuses (bad shape or an escaping write path)", async () => {
    vi.mocked(terminalService.createAgentSession).mockRejectedValue(
      new AgentDescriptorError(
        'Workspace write path "../../.ssh/config" escapes the bench workspace',
      ),
    );

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent" });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/escapes the bench workspace/);
  });

  it.each([
    ["below-floor-version", 409],
    ["missing-binary", 409],
    ["launch-failure", 409],
    ["host-install-broken", 500],
  ])("maps a %s launch failure to %i with the structured body (#519)", async (cls, status) => {
    vi.mocked(terminalService.createAgentSession).mockRejectedValue(
      new AgentLaunchFailureError({
        class: cls as never,
        message: "Acme Agent requires CLI version 2.1.111 or newer, but 2.1.100 is installed.",
        guidance: "Update the agent CLI to 2.1.111 or newer, then launch again.",
        detectedVersion: "2.1.100",
        minVersion: "2.1.111",
        actions: ["open-plugin-settings", "retry"],
      }),
    );

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent" });

    expect(res.status).toBe(status);
    // Both shapes: `error` for anything reading the plain message, and the whole
    // failure for the terminal pane's error panel (AP-TC-071, AP-TC-076).
    expect(res.body.error).toMatch(/2.1.111/);
    expect(res.body.launchFailure).toMatchObject({
      class: cls,
      detectedVersion: "2.1.100",
      minVersion: "2.1.111",
      actions: ["open-plugin-settings", "retry"],
    });
  });

  it("reports an above-ceiling launch as compatibility on the 201, and stays silent in range", async () => {
    const withCompatibility = (compatibility: Record<string, unknown>) => {
      vi.mocked(terminalService.createAgentSession).mockResolvedValue({
        session: AGENT_SESSION,
        promptInjection: { mode: "argv-positional", injected: false },
        compatibility,
      } as never);
    };

    withCompatibility({
      status: "above-tested-ceiling",
      detectedVersion: "2.1.207",
      testedCeiling: "2.1.205",
    });

    const warned = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent" });

    expect(warned.status).toBe(201);
    expect(warned.body.compatibility).toMatchObject({ status: "above-tested-ceiling" });

    // An in-range launch says nothing at all: no warning is the observable
    // outcome AP-TC-070 asks for.
    withCompatibility({ status: "within-tested-range", detectedVersion: "2.1.180" });

    const quiet = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent" });

    expect(quiet.status).toBe(201);
    expect(quiet.body.compatibility).toBeUndefined();
  });

  it("returns 500 when the PTY spawn itself fails", async () => {
    vi.mocked(terminalService.createAgentSession).mockRejectedValue(
      new Error("Failed to spawn agent session (command: acme, cwd: /workspace): ENOENT"),
    );

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent" });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Agent session could not be started/);
  });

  it("refuses a non-operable bench before reaching the agent pipeline", async () => {
    vi.mocked(benchManager.getBench).mockReturnValue({
      ...MOCK_BENCH,
      workspacePath: "",
    } as unknown as ReturnType<typeof benchManager.getBench>);

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent" });

    expect(res.status).toBe(400);
    expect(terminalService.createAgentSession).not.toHaveBeenCalled();
  });
});

describe("jig-driven agent resolution (AP-FR-006, issue #515)", () => {
  const AGENT_SESSION = {
    id: "agent-2",
    benchKey: "project1:1",
    label: "Codex CLI 1 - My Project #1",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "live" as const,
    command: "codex",
    agentPluginId: "codex-cli",
  };

  const BOUND_JIG = { ...MOCK_JIG, agentPluginId: "codex-cli" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    mockAgentLaunch(AGENT_SESSION);
    vi.mocked(terminalService.createSession).mockReturnValue({
      id: "term-1",
      benchKey: "project1:1",
      label: "Terminal 1 - My Project #1",
      createdAt: "2026-01-01T00:00:00.000Z",
      status: "live",
    });
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Push feature/test to GitHub");
    vi.mocked(state.loadSettings).mockReturnValue({
      jigs: { autoInject: true, autoExecute: true, defaultAgentPluginId: "claude-code" },
    });
    pipelineMocks.resolveLaunchAgentId.mockReturnValue(undefined);
  });

  it("resolves with the jig's binding and the stored default agent", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(
      BOUND_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );

    await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(pipelineMocks.resolveLaunchAgentId).toHaveBeenCalledWith({
      jigAgentPluginId: "codex-cli",
      defaultAgentPluginId: "claude-code",
    });
  });

  it("launches the resolved agent with the resolved jig as the initial prompt (AP-TC-037)", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(
      BOUND_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    pipelineMocks.resolveLaunchAgentId.mockReturnValue("codex-cli");

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe("agent-2");
    expect(res.body.jigInjected).toBe(true);
    expect(terminalService.createSession).not.toHaveBeenCalled();
    expect(terminalService.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPluginId: "codex-cli",
        initialInput: "Push feature/test to GitHub",
      }),
    );
  });

  it("omits the jig binding from the resolver call when the jig has none", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );

    await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(pipelineMocks.resolveLaunchAgentId).toHaveBeenCalledWith({
      defaultAgentPluginId: "claude-code",
    });
  });

  it("fails the launch when nothing resolves an agent, with no built-in left (AP-TC-103)", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    pipelineMocks.resolveLaunchAgentId.mockReturnValue(undefined);

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no ai coding agent is available/i);
    expect(terminalService.createAgentSession).not.toHaveBeenCalled();
    expect(terminalService.createSession).not.toHaveBeenCalled();
  });

  it("lets an explicit agentPluginId win over the jig-driven resolution", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(
      BOUND_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    // The jig keeps the jig-driven branch live, and the resolver is primed with
    // a DIFFERENT agent, so the assertions below fail if the precedence is ever
    // inverted rather than passing because the branch was never reached.
    pipelineMocks.resolveLaunchAgentId.mockReturnValue("codex-cli");

    await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent", jigId: "push" });

    expect(pipelineMocks.resolveLaunchAgentId).not.toHaveBeenCalled();
    expect(terminalService.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ agentPluginId: "acme-agent" }),
    );
  });

  it("writes the jig after startup on an agent launch when autoExecute is off", async () => {
    vi.useFakeTimers();
    vi.mocked(jigManager.getJig).mockReturnValue(
      BOUND_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(state.loadSettings).mockReturnValue({
      jigs: { autoInject: true, autoExecute: false, defaultAgentPluginId: "claude-code" },
    });
    pipelineMocks.resolveLaunchAgentId.mockReturnValue("codex-cli");

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.body.jigScheduled).toBe(true);
    expect(terminalService.writeToSession).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(terminalService.writeToSession).toHaveBeenCalledWith(
      "agent-2",
      "Push feature/test to GitHub",
    );
    vi.useRealTimers();
  });

  // The launch surfaces send `agentPluginId` with no `command` at all (issue
  // #517), so jig resolution can no longer hang off the legacy `claude`
  // command. Without this the jig is silently dropped from every such launch:
  // the request still succeeds and the agent still starts, just with no jig,
  // which is exactly the kind of failure no other assertion here would catch.
  it("resolves the jig on a command-less agent launch (AP-FR-007, issue #517)", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent", jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigInjected).toBe(true);
    expect(jigManager.getJig).toHaveBeenCalledWith("project1", "push");
    expect(terminalService.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPluginId: "acme-agent",
        initialInput: "Push feature/test to GitHub",
      }),
    );
  });

  it("404s an unknown jig on a command-less agent launch rather than launching without it", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue(null);

    const res = await request(app)
      .post("/project1/benches/1/terminals")
      .send({ agentPluginId: "acme-agent", jigId: "ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Jig not found");
    expect(terminalService.createAgentSession).not.toHaveBeenCalled();
  });
});

// AP-TC-063: injection is the agent's declared capability, so an agent that
// declares none is not injected into by any route: not positionally (core
// already skipped it) and not through the post-startup PTY write either.
describe("an agent that declares no injection capability (AP-FR-018, AP-TC-063)", () => {
  const AGENT_SESSION = {
    id: "agent-3",
    benchKey: "project1:1",
    label: "Mute Agent 1 - My Project #1",
    createdAt: "2026-01-01T00:00:00.000Z",
    status: "live" as const,
    command: "mute",
    agentPluginId: "mute-agent",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(benchManager.getBench).mockReturnValue(
      MOCK_BENCH as unknown as ReturnType<typeof benchManager.getBench>,
    );
    vi.mocked(projectRegistry.getProject).mockReturnValue(
      MOCK_PROJECT as unknown as ReturnType<typeof projectRegistry.getProject>,
    );
    vi.mocked(jigManager.getJig).mockReturnValue(
      MOCK_JIG as unknown as ReturnType<typeof jigManager.getJig>,
    );
    vi.mocked(jigManager.resolveJigContent).mockReturnValue("Push feature/test to GitHub");
    pipelineMocks.resolveLaunchAgentId.mockReturnValue("mute-agent");
    mockAgentLaunch(AGENT_SESSION, "none");
  });

  it("launches normally with nothing injected and reports neither flag (autoExecute on)", async () => {
    vi.useFakeTimers();
    vi.mocked(state.loadSettings).mockReturnValue({
      jigs: { autoInject: true, autoExecute: true },
    });

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe("agent-3");
    expect(res.body.jigInjected).toBeUndefined();
    expect(res.body.jigScheduled).toBeUndefined();
    vi.runAllTimers();
    expect(terminalService.writeToSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("skips the scheduled PTY write entirely when autoExecute is off", async () => {
    vi.useFakeTimers();
    vi.mocked(state.loadSettings).mockReturnValue({
      jigs: { autoInject: true, autoExecute: false },
    });

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.jigScheduled).toBeUndefined();
    expect(res.body.jigInjected).toBeUndefined();
    vi.runAllTimers();
    expect(terminalService.writeToSession).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("still reports a jig's sizeWarning, which is about the jig and not the agent", async () => {
    vi.mocked(jigManager.getJig).mockReturnValue({
      ...MOCK_JIG,
      sizeWarning: true,
    } as unknown as ReturnType<typeof jigManager.getJig>);

    const res = await request(app).post("/project1/benches/1/terminals").send({ jigId: "push" });

    expect(res.status).toBe(201);
    expect(res.body.sizeWarning).toBe(true);
    expect(res.body.jigInjected).toBeUndefined();
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
