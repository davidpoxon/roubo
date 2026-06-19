import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { stateMocks } = vi.hoisted(() => ({
  stateMocks: { loadState: vi.fn() },
}));
vi.mock("../services/state.js", () => stateMocks);

import router from "./migration.js";

const app = express();
app.use("/", router);

beforeEach(() => {
  stateMocks.loadState.mockReset();
});

describe("GET /status", () => {
  it("returns nulls and an empty notices map when the state has none set", async () => {
    stateMocks.loadState.mockReturnValue({ benches: [] });
    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schemaVersion: null, migration: null, notices: {} });
  });

  it("surfaces the schemaVersion and migration record when set", async () => {
    stateMocks.loadState.mockReturnValue({
      benches: [],
      schemaVersion: 1,
      migration: {
        status: "success",
        at: "2026-05-23T10:00:00.000Z",
        migratedProjectIds: ["alpha", "beta"],
      },
    });
    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      schemaVersion: 1,
      migration: {
        status: "success",
        at: "2026-05-23T10:00:00.000Z",
        migratedProjectIds: ["alpha", "beta"],
      },
      notices: {},
    });
  });

  it("surfaces one-time notice markers when set (FR-018, issue #558)", async () => {
    stateMocks.loadState.mockReturnValue({
      benches: [],
      schemaVersion: 1,
      notices: { "only-to-do-default-v1": "2026-06-20T10:00:00.000Z" },
    });
    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      schemaVersion: 1,
      migration: null,
      notices: { "only-to-do-default-v1": "2026-06-20T10:00:00.000Z" },
    });
  });
});
