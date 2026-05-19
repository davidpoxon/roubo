import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  addClient,
  broadcast,
  broadcastBenchStatus,
  getClientCount,
  _resetClientsForTest,
} from "./sse.js";
import type { Response } from "express";
import type { BenchNotification } from "@roubo/shared";
import { makeBench } from "../test/fixtures.js";

function makeResponse(): Response {
  const handlers: Record<string, (() => void)[]> = {};
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      handlers[event] = handlers[event] ?? [];
      handlers[event].push(handler);
    }),
    _trigger: (event: string) => {
      for (const h of handlers[event] ?? []) h();
    },
  } as unknown as Response & { _trigger: (event: string) => void };
}

beforeEach(() => {
  _resetClientsForTest();
});

describe("addClient", () => {
  it("sets SSE headers and writes initial comment", () => {
    const res = makeResponse() as Response & { _trigger: (event: string) => void };
    addClient(res);

    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/event-stream");
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(res.setHeader).toHaveBeenCalledWith("Connection", "keep-alive");
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res.write).toHaveBeenCalledWith(":ok\n\n");

    res._trigger("close");
  });

  it("increments client count on connect and decrements on close", () => {
    const res = makeResponse() as Response & { _trigger: (event: string) => void };

    addClient(res);
    expect(getClientCount()).toBe(1);

    res._trigger("close");
    expect(getClientCount()).toBe(0);
  });
});

describe("broadcast", () => {
  it("writes SSE-formatted JSON to all connected clients", () => {
    const res1 = makeResponse() as Response & { _trigger: (event: string) => void };
    const res2 = makeResponse() as Response & { _trigger: (event: string) => void };
    addClient(res1);
    addClient(res2);

    const notifications: BenchNotification[] = [
      { id: "n1", type: "bench-ready", priority: "info", createdAt: "2026-01-01T00:00:00.000Z" },
    ];
    const event = {
      type: "notifications" as const,
      projectId: "proj-1",
      benchId: 1,
      notifications,
    };

    broadcast(event);

    const expected = `data: ${JSON.stringify(event)}\n\n`;
    expect(res1.write).toHaveBeenCalledWith(expected);
    expect(res2.write).toHaveBeenCalledWith(expected);

    res1._trigger("close");
    res2._trigger("close");
  });

  it("does not write to clients that have disconnected", () => {
    const res = makeResponse() as Response & { _trigger: (event: string) => void };
    addClient(res);
    res._trigger("close");

    const writeCalls = vi.mocked(res.write).mock.calls.length;

    broadcast({ type: "notifications", projectId: "proj-1", benchId: 1, notifications: [] });

    expect(vi.mocked(res.write).mock.calls.length).toBe(writeCalls);
  });

  it("removes a client and continues broadcasting if write throws", () => {
    const failing = makeResponse() as Response & { _trigger: (event: string) => void };
    const healthy = makeResponse() as Response & { _trigger: (event: string) => void };
    vi.mocked(failing.write)
      .mockImplementationOnce(() => true) // allow the initial ':ok\n\n' write in addClient
      .mockImplementation(() => {
        throw new Error("socket closed");
      });

    addClient(failing);
    addClient(healthy);
    expect(getClientCount()).toBe(2);

    const event = {
      type: "notifications" as const,
      projectId: "proj-1",
      benchId: 1,
      notifications: [],
    };
    expect(() => broadcast(event)).not.toThrow();

    expect(getClientCount()).toBe(1);
    expect(healthy.write).toHaveBeenCalledWith(`data: ${JSON.stringify(event)}\n\n`);

    healthy._trigger("close");
  });

  it("broadcasts to no one without error when no clients connected", () => {
    expect(() =>
      broadcast({ type: "notifications", projectId: "proj-1", benchId: 1, notifications: [] }),
    ).not.toThrow();
  });

  it("writes a bench-status event to all connected clients", () => {
    const res = makeResponse() as Response & { _trigger: (event: string) => void };
    addClient(res);

    const event = {
      type: "bench-status" as const,
      projectId: "proj-1",
      benchId: 1,
      status: "idle" as const,
    };

    broadcast(event);

    expect(res.write).toHaveBeenCalledWith(`data: ${JSON.stringify(event)}\n\n`);
    res._trigger("close");
  });
});

describe("broadcastBenchStatus", () => {
  it("broadcasts a bench-status event derived from the bench", () => {
    const res = makeResponse() as Response & { _trigger: (event: string) => void };
    addClient(res);

    const bench = makeBench({ id: 7, projectId: "proj-7", status: "idle" });

    broadcastBenchStatus(bench);

    expect(res.write).toHaveBeenCalledWith(
      `data: ${JSON.stringify({
        type: "bench-status",
        projectId: "proj-7",
        benchId: 7,
        status: "idle",
      })}\n\n`,
    );
    res._trigger("close");
  });
});
