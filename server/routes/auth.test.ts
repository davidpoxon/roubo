import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/github-auth.js");
vi.mock("../services/github.js", () => ({ resetOctokit: vi.fn() }));

import router from "./auth.js";
import * as githubAuth from "../services/github-auth.js";
import * as github from "../services/github.js";

const app = express();
app.use(express.json());
app.use("/", router);

describe("GET /authorize", () => {
  it("returns 200 with a GitHub authorization URL", async () => {
    vi.mocked(githubAuth.buildAuthorizationUrl).mockReturnValue({
      url: "https://github.com/login/oauth/authorize?client_id=Ov23li8FytWzZPHmc7fm&state=abc123",
    });

    const res = await request(app).get("/authorize");
    expect(res.status).toBe(200);
    expect(res.body.url).toContain("github.com/login/oauth/authorize");
  });

  it("returns 500 when buildAuthorizationUrl throws", async () => {
    vi.mocked(githubAuth.buildAuthorizationUrl).mockImplementation(() => {
      throw new Error("Crypto failure");
    });

    const res = await request(app).get("/authorize");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Crypto failure");
  });
});

describe("GET /status", () => {
  it("returns connected: false when not connected", async () => {
    vi.mocked(githubAuth.getConnectionStatus).mockImplementation(async () => ({
      connected: false,
    }));

    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connected: false });
  });

  it("returns connected: true with username when connected", async () => {
    vi.mocked(githubAuth.getConnectionStatus).mockImplementation(async () => ({
      connected: true,
      username: "testuser",
      scopes: ["repo", "read:org", "read:project"],
    }));

    const res = await request(app).get("/status");
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.username).toBe("testuser");
  });

  it("returns 500 when getConnectionStatus throws", async () => {
    vi.mocked(githubAuth.getConnectionStatus).mockImplementation(async () => {
      throw new Error("Read error");
    });

    const res = await request(app).get("/status");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Read error");
  });
});

describe("POST /exchange", () => {
  it("returns 400 when code is missing", async () => {
    const res = await request(app).post("/exchange").send({ state: "valid-state" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing");
  });

  it("returns 400 when code is an array rather than a scalar string", async () => {
    const res = await request(app)
      .post("/exchange")
      .send({ code: ["a", "b"], state: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing");
  });

  it("returns 400 when state is missing", async () => {
    const res = await request(app).post("/exchange").send({ code: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Missing");
  });

  it("returns 400 when state is invalid", async () => {
    vi.mocked(githubAuth.validateState).mockReturnValue(false);

    const res = await request(app).post("/exchange").send({ code: "abc", state: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid");
  });

  it("exchanges code, saves credentials, resets Octokit, and returns ok with username", async () => {
    vi.mocked(githubAuth.validateState).mockReturnValue(true);
    vi.mocked(githubAuth.exchangeCodeForToken).mockResolvedValue({
      token: "gho_test",
      scopes: ["repo"],
    });
    vi.mocked(githubAuth.fetchGitHubUsername).mockResolvedValue("octocat");
    vi.mocked(githubAuth.saveCredentials).mockResolvedValue(undefined);

    const res = await request(app)
      .post("/exchange")
      .send({ code: "good-code", state: "valid-state" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, username: "octocat" });
    expect(githubAuth.saveCredentials).toHaveBeenCalledWith("gho_test", "octocat", ["repo"]);
    expect(github.resetOctokit).toHaveBeenCalled();
    expect(githubAuth.clearStatusCache).toHaveBeenCalled();
  });

  it("returns 500 when token exchange fails", async () => {
    vi.mocked(githubAuth.validateState).mockReturnValue(true);
    vi.mocked(githubAuth.exchangeCodeForToken).mockRejectedValue(new Error("Exchange failed"));

    const res = await request(app).post("/exchange").send({ code: "abc", state: "valid" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Exchange failed");
  });
});

describe("DELETE /", () => {
  it("calls deleteCredentials and resetOctokit and returns 204", async () => {
    vi.mocked(githubAuth.deleteCredentials).mockResolvedValue(undefined);

    const res = await request(app).delete("/");
    expect(res.status).toBe(204);
    expect(githubAuth.deleteCredentials).toHaveBeenCalled();
    expect(github.resetOctokit).toHaveBeenCalled();
  });

  it("returns 500 when deleteCredentials throws", async () => {
    vi.mocked(githubAuth.deleteCredentials).mockRejectedValue(new Error("Permission denied"));

    const res = await request(app).delete("/");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Permission denied");
  });
});
