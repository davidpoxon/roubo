import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/terminal.js", () => ({
  getSession: vi.fn(),
  parseBenchKey: vi.fn(),
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
});

describe("POST /claude-notification", () => {
  it("creates a claude-waiting notification and returns ok", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const session = { id: sessionId, benchKey: "project1:1", command: "claude", status: "live" };
    vi.mocked(terminalService.getSession).mockReturnValue(session as any);
    vi.mocked(terminalService.parseBenchKey).mockReturnValue({ projectId: "project1", benchId: 1 });
    vi.mocked(benchManager.getBench).mockReturnValue(mockBench as any);
    vi.mocked(notificationService.createNotification).mockReturnValue({
      id: "notif-1",
      type: "claude-waiting",
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
      "claude-waiting",
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

  it("returns 404 when session is not found", async () => {
    vi.mocked(terminalService.getSession).mockReturnValue(undefined);

    const res = await request(app)
      .post("/claude-notification")
      .send({ session_id: "550e8400-e29b-41d4-a716-446655440000" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it("returns 400 when session is not a Claude session", async () => {
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    vi.mocked(terminalService.getSession).mockReturnValue({
      id: sessionId,
      benchKey: "project1:1",
      command: undefined,
      status: "live",
    } as any);

    const res = await request(app).post("/claude-notification").send({ session_id: sessionId });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Claude");
    expect(notificationService.createNotification).not.toHaveBeenCalled();
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
      type: "claude-waiting",
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
