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
  it("returns nulls when the state has neither schemaVersion nor migration", async () => {
    stateMocks.loadState.mockReturnValue({ benches: [] });
    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ schemaVersion: null, migration: null });
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
    });
  });
});
