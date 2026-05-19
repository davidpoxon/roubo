import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/sse.js", () => ({
  addClient: vi.fn((res: import("express").Response) => res.end()),
}));

import router from "./notifications.js";
import * as sseService from "../services/sse.js";

const app = express();
app.use("/", router);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /stream", () => {
  it("calls sseService.addClient with the response", async () => {
    await request(app).get("/stream");
    expect(sseService.addClient).toHaveBeenCalledTimes(1);
  });
});
