import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/terminal.js", () => ({
  getSession: vi.fn(),
  parseBenchKey: vi.fn(),
  isHookNotificationEligible: vi.fn(),
  resolveNotifierSession: vi.fn(),
  isNotifierNotificationEligible: vi.fn(),
}));

vi.mock("../services/notification.js", () => ({
  createNotification: vi.fn(),
}));

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
}));

import router from "./hooks.js";
import * as terminalService from "../services/terminal.js";
import * as notificationService from "../services/notification.js";
import * as benchManager from "../services/bench-manager.js";

const app = express();
app.use(express.json());
app.use("/", router);

const mockBench = { id: 1, projectId: "project1", notifications: [] };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: a live, hook-wired session. The rejection rows below opt out.
  vi.mocked(terminalService.isHookNotificationEligible).mockReturnValue(true);
  vi.mocked(terminalService.isNotifierNotificationEligible).mockReturnValue(true);
});

describe("POST /claude-notification", () => {
  it("creates a agent-waiting notification and returns ok", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const session = { id: sessionId, benchKey: "project1:1", command: "claude", status: "live" };
    vi.mocked(terminalService.getSession).mockReturnValue(session as any);
    vi.mocked(terminalService.parseBenchKey).mockReturnValue({ projectId: "project1", benchId: 1 });
    vi.mocked(benchManager.getBench).mockReturnValue(mockBench as any);
    vi.mocked(notificationService.createNotification).mockReturnValue({
      id: "notif-1",
      type: "agent-waiting",
      priority: "action-needed",
      sourceSessionId: sessionId,
      createdAt: new Date().toISOString(),
    });

    const res = await request(app).post("/claude-notification").send({
      session_id: sessionId,
      notification_type: "permission_prompt",
      message: "Claude needs permission",
      title: "Permission needed",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(terminalService.getSession).toHaveBeenCalledWith(sessionId);
    expect(terminalService.parseBenchKey).toHaveBeenCalledWith("project1:1");
    expect(benchManager.getBench).toHaveBeenCalledWith("project1", 1);
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      mockBench,
      "agent-waiting",
      sessionId,
    );
  });

  it("returns 400 when session_id is missing", async () => {
    const res = await request(app)
      .post("/claude-notification")
      .send({ notification_type: "permission_prompt" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 400 when session_id is not a string", async () => {
    const res = await request(app).post("/claude-notification").send({ session_id: 12345 });

    expect(res.status).toBe(400);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 404 and logs when session is not found (AP-TC-069)", async () => {
    vi.mocked(terminalService.getSession).mockReturnValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/claude-notification")
      .send({ session_id: "550e8400-e29b-41d4-a716-446655440000" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown session"),
      "550e8400-e29b-41d4-a716-446655440000",
    );
    warnSpy.mockRestore();
  });

  it("returns 400 and logs when the session declares no hook wiring (AP-TC-069)", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    vi.mocked(terminalService.getSession).mockReturnValue({
      id: sessionId,
      benchKey: "project1:1",
      command: "acme",
      status: "live",
      agentPluginId: "acme-agent",
    } as any);
    vi.mocked(terminalService.isHookNotificationEligible).mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).post("/claude-notification").send({ session_id: sessionId });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hook-wired/);
    expect(res.body.error).not.toMatch(/claude/i);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("hook-wired"), sessionId);
    warnSpy.mockRestore();
  });

  it("returns 400 for an expired correlation token from an already-exited session (AP-TC-084)", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    // An exited session is still addressable by id (its scrollback survives),
    // so the live check, not the lookup, is what rejects the stale token.
    vi.mocked(terminalService.getSession).mockReturnValue({
      id: sessionId,
      benchKey: "project1:1",
      command: "claude",
      status: "ended",
      exitCode: 0,
    } as any);
    vi.mocked(terminalService.isHookNotificationEligible).mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).post("/claude-notification").send({ session_id: sessionId });

    expect(res.status).toBe(400);
    expect(terminalService.isHookNotificationEligible).toHaveBeenCalledWith(sessionId);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("accepts a hook-wired agent session that is not the built-in claude command", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    vi.mocked(terminalService.getSession).mockReturnValue({
      id: sessionId,
      benchKey: "project1:1",
      command: "acme",
      status: "live",
      agentPluginId: "acme-agent",
    } as any);
    vi.mocked(terminalService.parseBenchKey).mockReturnValue({ projectId: "project1", benchId: 1 });
    vi.mocked(benchManager.getBench).mockReturnValue(mockBench as any);

    const res = await request(app).post("/claude-notification").send({ session_id: sessionId });

    expect(res.status).toBe(200);
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      mockBench,
      "agent-waiting",
      sessionId,
    );
  });

  it("returns 500 when bench key cannot be parsed", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    vi.mocked(terminalService.getSession).mockReturnValue({
      id: sessionId,
      benchKey: "invalid",
      command: "claude",
      status: "live",
    } as any);
    vi.mocked(terminalService.parseBenchKey).mockReturnValue(null);

    const res = await request(app).post("/claude-notification").send({ session_id: sessionId });

    expect(res.status).toBe(500);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 404 when bench is not found", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    vi.mocked(terminalService.getSession).mockReturnValue({
      id: sessionId,
      benchKey: "project1:1",
      command: "claude",
      status: "live",
    } as any);
    vi.mocked(terminalService.parseBenchKey).mockReturnValue({ projectId: "project1", benchId: 1 });
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).post("/claude-notification").send({ session_id: sessionId });

    expect(res.status).toBe(404);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 500 when createNotification throws", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    vi.mocked(terminalService.getSession).mockReturnValue({
      id: sessionId,
      benchKey: "project1:1",
      command: "claude",
      status: "live",
    } as any);
    vi.mocked(terminalService.parseBenchKey).mockReturnValue({ projectId: "project1", benchId: 1 });
    vi.mocked(benchManager.getBench).mockReturnValue(mockBench as any);
    vi.mocked(notificationService.createNotification).mockImplementation(() => {
      throw new Error("storage error");
    });

    const res = await request(app).post("/claude-notification").send({ session_id: sessionId });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("storage error");
  });

  it("deduplicates: second call still returns ok (notification service handles dedup)", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const existingNotification = {
      id: "notif-1",
      type: "agent-waiting",
      priority: "action-needed",
      sourceSessionId: sessionId,
      createdAt: new Date().toISOString(),
    };
    vi.mocked(terminalService.getSession).mockReturnValue({
      id: sessionId,
      benchKey: "project1:1",
      command: "claude",
      status: "live",
    } as any);
    vi.mocked(terminalService.parseBenchKey).mockReturnValue({ projectId: "project1", benchId: 1 });
    vi.mocked(benchManager.getBench).mockReturnValue(mockBench as any);
    vi.mocked(notificationService.createNotification).mockReturnValue(existingNotification as any);

    const payload = { session_id: sessionId, notification_type: "permission_prompt" };
    const res1 = await request(app).post("/claude-notification").send(payload);
    const res2 = await request(app).post("/claude-notification").send(payload);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(notificationService.createNotification).toHaveBeenCalledTimes(2);
  });
});

describe("POST /agent-notification (issue #698)", () => {
  const sessionId = "550e8400-e29b-41d4-a716-446655440000";
  const token = `roubo:${sessionId}`;

  function liveNotifierSession() {
    vi.mocked(terminalService.resolveNotifierSession).mockReturnValue({
      id: sessionId,
      benchKey: "project1:1",
      command: "acme",
      status: "live",
      agentPluginId: "acme-agent",
    } as any);
    vi.mocked(terminalService.parseBenchKey).mockReturnValue({ projectId: "project1", benchId: 1 });
    vi.mocked(benchManager.getBench).mockReturnValue(mockBench as any);
  }

  it("trades a live correlation token for its session and raises one notification", async () => {
    liveNotifierSession();

    const res = await request(app)
      .post("/agent-notification")
      .send({ token, payload: '{"type":"agent-turn-complete"}' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(terminalService.resolveNotifierSession).toHaveBeenCalledWith(token);
    expect(notificationService.createNotification).toHaveBeenCalledWith(
      mockBench,
      "agent-waiting",
      sessionId,
    );
  });

  it("accepts a notification carrying no payload at all", async () => {
    liveNotifierSession();

    const res = await request(app).post("/agent-notification").send({ token });

    expect(res.status).toBe(200);
    expect(notificationService.createNotification).toHaveBeenCalledTimes(1);
  });

  it("returns 400 when the token is missing", async () => {
    const res = await request(app).post("/agent-notification").send({ payload: "{}" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 400 when the token is not a string", async () => {
    const res = await request(app).post("/agent-notification").send({ token: 12345 });

    expect(res.status).toBe(400);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 404 and logs for an unregistered token", async () => {
    vi.mocked(terminalService.resolveNotifierSession).mockReturnValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).post("/agent-notification").send({ token });

    expect(res.status).toBe(404);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("unknown correlation token"),
      token,
    );
    warnSpy.mockRestore();
  });

  it("returns 400 for a token whose session has already exited", async () => {
    liveNotifierSession();
    vi.mocked(terminalService.isNotifierNotificationEligible).mockReturnValue(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).post("/agent-notification").send({ token });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/notifier-wired/);
    // Agent-generic: the rejection names the mechanism, never an agent.
    expect(res.body.error).not.toMatch(/claude|codex/i);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns 500 when the bench key cannot be parsed", async () => {
    liveNotifierSession();
    vi.mocked(terminalService.parseBenchKey).mockReturnValue(null);

    const res = await request(app).post("/agent-notification").send({ token });

    expect(res.status).toBe(500);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 404 when the bench is gone", async () => {
    liveNotifierSession();
    vi.mocked(benchManager.getBench).mockReturnValue(undefined);

    const res = await request(app).post("/agent-notification").send({ token });

    expect(res.status).toBe(404);
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 500 when createNotification throws", async () => {
    liveNotifierSession();
    vi.mocked(notificationService.createNotification).mockImplementation(() => {
      throw new Error("storage error");
    });

    const res = await request(app).post("/agent-notification").send({ token });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("storage error");
  });
});
