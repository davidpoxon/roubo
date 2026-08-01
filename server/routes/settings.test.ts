import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../services/state.js");
vi.mock("../services/env.js");

import router from "./settings.js";
import * as state from "../services/state.js";
import * as env from "../services/env.js";

const app = express();
app.use(express.json());
app.use("/", router);

describe("GET /", () => {
  beforeEach(() => {
    vi.mocked(state.hasLegacyAgentSettings).mockReturnValue(false);
    vi.mocked(env.getContextWindow).mockReturnValue(200_000);
  });

  it("returns current settings", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ theme: "dark" });
  });

  it("includes contextWindow from getContextWindow()", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    vi.mocked(env.getContextWindow).mockReturnValue(200_000);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.contextWindow).toBe(200_000);
  });

  it("reflects a custom contextWindow when env override is set", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    vi.mocked(env.getContextWindow).mockReturnValue(1_000_000);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.contextWindow).toBe(1_000_000);
  });

  it("calls loadSettings to retrieve current settings", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "light" });

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(state.loadSettings).toHaveBeenCalled();
    expect(res.body).toMatchObject({ theme: "light" });
  });
});

describe("GET / legacyAgentSettingsPresent (AP-FR-021, #521)", () => {
  beforeEach(() => {
    vi.mocked(env.getContextWindow).mockReturnValue(200_000);
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
  });

  it("reports false on a fresh install, so the upgrade notice never shows (AP-TC-110)", async () => {
    vi.mocked(state.hasLegacyAgentSettings).mockReturnValue(false);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.legacyAgentSettingsPresent).toBe(false);
  });

  it("reports true when the raw settings file still carries the legacy block", async () => {
    vi.mocked(state.hasLegacyAgentSettings).mockReturnValue(true);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body.legacyAgentSettingsPresent).toBe(true);
  });

  it("never echoes the legacy preferences back, since nothing is migrated (AP-TC-111)", async () => {
    vi.mocked(state.hasLegacyAgentSettings).mockReturnValue(true);

    const res = await request(app).get("/");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("claudeCode");
  });
});

describe("PUT /", () => {
  beforeEach(() => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    vi.mocked(state.saveSettings).mockReturnValue(undefined);
  });

  it("saves and returns valid theme: light", async () => {
    const res = await request(app).put("/").send({ theme: "light" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ theme: "light" });
    expect(state.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));
  });

  it("saves and returns valid theme: dark", async () => {
    const res = await request(app).put("/").send({ theme: "dark" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ theme: "dark" });
  });

  it("saves and returns valid theme: system", async () => {
    const res = await request(app).put("/").send({ theme: "system" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ theme: "system" });
  });

  it("returns 400 for invalid theme value", async () => {
    const res = await request(app).put("/").send({ theme: "purple" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid theme/i);
  });

  it("returns 400 when theme is missing", async () => {
    const res = await request(app).put("/").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid theme/i);
  });

  it("returns 500 when saveSettings throws", async () => {
    vi.mocked(state.saveSettings).mockImplementation(() => {
      throw new Error("Disk full");
    });

    const res = await request(app).put("/").send({ theme: "light" });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Disk full");
  });

  it("saves valid jigs settings alongside theme", async () => {
    const jigs = { autoInject: true, autoExecute: false, defaultJigId: "cleanup" };
    const res = await request(app).put("/").send({ theme: "dark", jigs });
    expect(res.status).toBe(200);
    expect(res.body.jigs).toEqual(jigs);
    expect(state.saveSettings).toHaveBeenCalledWith({ theme: "dark", jigs });
  });

  it("returns 400 when autoInject is not a boolean", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        jigs: { autoInject: "yes", autoExecute: true, defaultJigId: "feature-dev" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid jig/i);
  });

  it("returns 400 when autoExecute is not a boolean", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        jigs: { autoInject: true, autoExecute: 1, defaultJigId: "feature-dev" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid jig/i);
  });

  it("returns 400 when defaultJigId is not a string", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        jigs: { autoInject: true, autoExecute: true, defaultJigId: 42 },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid jig/i);
  });

  it("returns 400 when defaultJigId contains invalid characters", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        jigs: { autoInject: true, autoExecute: true, defaultJigId: "My Jig!" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid jig/i);
  });

  it("returns 400 when defaultJigId is empty", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        jigs: { autoInject: true, autoExecute: true, defaultJigId: "" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid jig/i);
  });

  it("preserves existing jigs settings when not provided in request", async () => {
    const existingJigs = {
      autoInject: false,
      autoExecute: false,
      defaultJigId: "push",
    };
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      jigs: existingJigs,
    });

    const res = await request(app).put("/").send({ theme: "light" });
    expect(res.status).toBe(200);
    expect(res.body.jigs).toEqual(existingJigs);
  });

  it("accepts jigs without defaultJigId to clear the app default", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        jigs: { autoInject: true, autoExecute: true },
      });
    expect(res.status).toBe(200);
    expect(res.body.jigs.autoInject).toBe(true);
    expect(res.body.jigs.autoExecute).toBe(true);
    expect(res.body.jigs.defaultJigId).toBeUndefined();
  });

  it("accepts jigs with null defaultJigId to clear the app default", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        jigs: { autoInject: true, autoExecute: true, defaultJigId: null },
      });
    expect(res.status).toBe(200);
    expect(res.body.jigs.defaultJigId).toBeUndefined();
  });

  // Untagged on purpose (#680): this is the persistence half of AP-TC-018, not
  // the whole case. The bare id lives on the one test that asserts every
  // observation, e2e/agent-plugins/default-agent-tiles.spec.ts.
  it("persists defaultAgentPluginId", async () => {
    const jigs = { autoInject: true, autoExecute: true, defaultAgentPluginId: "codex-cli" };
    const res = await request(app).put("/").send({ theme: "dark", jigs });
    expect(res.status).toBe(200);
    expect(res.body.jigs.defaultAgentPluginId).toBe("codex-cli");
    expect(state.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ jigs }));
  });

  it("accepts jigs with a null defaultAgentPluginId to clear the default agent", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        jigs: { autoInject: true, autoExecute: true, defaultAgentPluginId: null },
      });
    expect(res.status).toBe(200);
    expect(res.body.jigs.defaultAgentPluginId).toBeUndefined();
  });

  it("returns 400 when defaultAgentPluginId is not a plugin id", async () => {
    for (const defaultAgentPluginId of [42, "Codex CLI", "../evil"]) {
      const res = await request(app)
        .put("/")
        .send({
          theme: "dark",
          jigs: { autoInject: true, autoExecute: true, defaultAgentPluginId },
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid jig/i);
    }
  });

  it("saves valid bench settings alongside theme", async () => {
    const benches = {
      enforceIssueDependencies: true,
      autoStartComponents: false,
    };
    const res = await request(app).put("/").send({ theme: "dark", benches });
    expect(res.status).toBe(200);
    expect(res.body.benches).toEqual(benches);
    expect(state.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark", benches }),
    );
  });

  it("saves benches.autoStartComponents: true alongside theme", async () => {
    const benches = {
      enforceIssueDependencies: false,
      autoStartComponents: true,
    };
    const res = await request(app).put("/").send({ theme: "dark", benches });
    expect(res.status).toBe(200);
    expect(res.body.benches).toEqual(benches);
  });

  it("returns 400 when benches.enforceIssueDependencies is missing", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        benches: { autoStartComponents: false },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid bench/i);
  });

  it("returns 400 when benches.enforceIssueDependencies is not a boolean", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        benches: {
          enforceIssueDependencies: "yes",
          autoStartComponents: false,
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid bench/i);
  });

  it("returns 400 when benches.autoStartComponents is missing", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        benches: { enforceIssueDependencies: false },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid bench/i);
  });

  it("returns 400 when benches.autoStartComponents is not a boolean", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        benches: {
          enforceIssueDependencies: false,
          autoStartComponents: "yes",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid bench/i);
  });

  it("preserves existing bench settings (including autoStartComponents) when not provided in request", async () => {
    const existingBenches = {
      enforceIssueDependencies: false,
      autoStartComponents: true,
    };
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark", benches: existingBenches });

    const res = await request(app).put("/").send({ theme: "light" });
    expect(res.status).toBe(200);
    expect(res.body.benches).toEqual(existingBenches);
  });

  it("returns 400 when benches is null", async () => {
    const res = await request(app).put("/").send({ theme: "dark", benches: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid bench/i);
  });

  // The route replaces the whole benches block, so every payload below carries the
  // two required booleans plus the maxGlobal value under test. The spec's abbreviated
  // { benches: { maxGlobal } } shorthand is illustrative; sent literally it would 400
  // on the missing booleans rather than exercising the maxGlobal rule.
  const validBenches = {
    enforceIssueDependencies: false,
    autoStartComponents: false,
  };

  it("accepts an absent benches.maxGlobal (unlimited) and persists no maxGlobal field", async () => {
    const res = await request(app).put("/").send({ theme: "dark", benches: validBenches });
    expect(res.status).toBe(200);
    expect(res.body.benches).toEqual(validBenches);
    expect(res.body.benches.maxGlobal).toBeUndefined();
  });

  it("persists benches.maxGlobal = 5", async () => {
    const benches = { ...validBenches, maxGlobal: 5 };
    const res = await request(app).put("/").send({ theme: "dark", benches });
    expect(res.status).toBe(200);
    expect(res.body.benches.maxGlobal).toBe(5);
    expect(state.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ benches: expect.objectContaining({ maxGlobal: 5 }) }),
    );
  });

  it("strips benches.maxGlobal = null before persisting (unlimited)", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", benches: { ...validBenches, maxGlobal: null } });
    expect(res.status).toBe(200);
    expect(res.body.benches).toEqual(validBenches);
    expect(res.body.benches).not.toHaveProperty("maxGlobal");
    expect(state.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        benches: expect.not.objectContaining({ maxGlobal: expect.anything() }),
      }),
    );
  });

  it.each([
    ["0", 0],
    ["a negative integer", -3],
    ["a non-integer", 2.5],
  ])("returns 400 when benches.maxGlobal is %s", async (_label, maxGlobal) => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", benches: { ...validBenches, maxGlobal } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/benches\.maxGlobal/);
  });

  it("returns 400 when benches.maxGlobal coerces to Infinity", async () => {
    // JSON has no Infinity literal, but a numeric literal that overflows the double
    // range (1e999) parses to Infinity, which is the wire form a hostile client would
    // use. Number.isInteger(Infinity) is false, so the guard rejects it. (NaN has no
    // JSON representation at all and cannot reach the route; the typeof guard covers
    // the non-number cases instead, see the string test below.)
    const rawBody = `{"theme":"dark","benches":{"enforceIssueDependencies":false,"autoStartComponents":false,"maxGlobal":1e999}}`;
    const res = await request(app).put("/").set("Content-Type", "application/json").send(rawBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/benches\.maxGlobal/);
  });

  it("returns 400 when benches.maxGlobal is a string", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", benches: { ...validBenches, maxGlobal: "5" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/benches\.maxGlobal/);
    expect(res.body.error).toMatch(/positive integer/);
  });

  it("remains unauthenticated: no auth headers still returns 200", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", benches: { ...validBenches, maxGlobal: 3 } });
    expect(res.status).toBe(200);
    expect([401, 403]).not.toContain(res.status);
  });

  it("saves valid testBench settings alongside theme", async () => {
    const testBench = { enabled: false };
    const res = await request(app).put("/").send({ theme: "dark", testBench });
    expect(res.status).toBe(200);
    expect(res.body.testBench).toEqual(testBench);
    expect(state.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "dark", testBench }),
    );
  });

  it("persists testBench.enabled: true round-trip", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", testBench: { enabled: true } });
    expect(res.status).toBe(200);
    expect(res.body.testBench).toEqual({ enabled: true });
  });

  it("returns 400 when testBench.enabled is not a boolean", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", testBench: { enabled: "yes" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid testBench/i);
  });

  it("returns 400 when testBench.enabled is missing", async () => {
    const res = await request(app).put("/").send({ theme: "dark", testBench: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid testBench/i);
  });

  it("returns 400 when testBench is null", async () => {
    const res = await request(app).put("/").send({ theme: "dark", testBench: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid testBench/i);
  });

  it("preserves existing testBench settings when not provided in request", async () => {
    const existingTestBench = { enabled: false };
    vi.mocked(state.loadSettings).mockReturnValue({
      theme: "dark",
      testBench: existingTestBench,
    });

    const res = await request(app).put("/").send({ theme: "light" });
    expect(res.status).toBe(200);
    expect(res.body.testBench).toEqual(existingTestBench);
  });
});

describe("PUT / github settings", () => {
  beforeEach(() => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    vi.mocked(state.saveSettings).mockReturnValue(undefined);
  });

  it("saves valid github settings", async () => {
    const github = { issueTypesCacheTtlSeconds: 60 };
    const res = await request(app).put("/").send({ theme: "dark", github });
    expect(res.status).toBe(200);
    expect(res.body.github).toEqual(github);
    expect(state.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ github }));
  });

  it("accepts 0 as a valid issueTypesCacheTtlSeconds (disables cache)", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", github: { issueTypesCacheTtlSeconds: 0 } });
    expect(res.status).toBe(200);
    expect(res.body.github).toEqual({ issueTypesCacheTtlSeconds: 0 });
  });

  it("returns 400 when issueTypesCacheTtlSeconds is negative", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", github: { issueTypesCacheTtlSeconds: -1 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid github/i);
  });

  it("returns 400 when issueTypesCacheTtlSeconds is a float", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", github: { issueTypesCacheTtlSeconds: 1.5 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid github/i);
  });

  it("returns 400 when issueTypesCacheTtlSeconds is not a number", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", github: { issueTypesCacheTtlSeconds: "fast" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid github/i);
  });

  it("returns 400 when github is null", async () => {
    const res = await request(app).put("/").send({ theme: "dark", github: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid github/i);
  });

  it("returns 400 when github is an empty object (issueTypesCacheTtlSeconds missing)", async () => {
    const res = await request(app).put("/").send({ theme: "dark", github: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid github/i);
  });
});

// App-level agent tool presets (AP-FR-008, issue #516).
describe("PUT / agentTools", () => {
  beforeEach(() => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark" });
    vi.mocked(state.saveSettings).mockReturnValue(undefined);
  });

  const valid = {
    id: "at-1",
    name: "Deep work",
    agent: "claude-code",
    params: { mode: "plan" },
    jig: "__none__",
  };

  it("saves a valid agent tool preset", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", agentTools: [valid] });
    expect(res.status).toBe(200);
    expect(res.body.agentTools).toEqual([valid]);
    expect(state.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ agentTools: [valid] }),
    );
  });

  it("saves a preset bound to the default agent", async () => {
    const preset = { id: "at-2", name: "Agent", agent: "default" };
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", agentTools: [preset] });
    expect(res.status).toBe(200);
    expect(res.body.agentTools).toEqual([preset]);
  });

  it("persists an empty list, which is how the last preset is deleted", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark", agentTools: [valid] });
    const res = await request(app).put("/").send({ theme: "dark", agentTools: [] });
    expect(res.status).toBe(200);
    expect(res.body.agentTools).toEqual([]);
  });

  it("keeps the stored presets when agentTools is absent", async () => {
    vi.mocked(state.loadSettings).mockReturnValue({ theme: "dark", agentTools: [valid] });
    const res = await request(app).put("/").send({ theme: "dark" });
    expect(res.status).toBe(200);
    expect(res.body.agentTools).toEqual([valid]);
  });

  it("returns 400 when agentTools is not an array", async () => {
    const res = await request(app).put("/").send({ theme: "dark", agentTools: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be an array/i);
  });

  it("returns 400 for a preset with no name", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", agentTools: [{ id: "at-1", name: "  ", agent: "default" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agentTools\[0\]\.name/);
  });

  it("returns 400 for a preset whose agent is neither 'default' nor a plugin id", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", agentTools: [{ id: "at-1", name: "X", agent: "Claude Code" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agentTools\[0\]\.agent/);
  });

  it("returns 400 for a duplicate preset id", async () => {
    const res = await request(app)
      .put("/")
      .send({
        theme: "dark",
        agentTools: [
          { id: "at-1", name: "A", agent: "default" },
          { id: "at-1", name: "B", agent: "default" },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/duplicate id/i);
  });

  it("returns 400 when params is not an object", async () => {
    const res = await request(app)
      .put("/")
      .send({ theme: "dark", agentTools: [{ ...valid, params: "plan" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/agentTools\[0\]\.params/);
  });
});

describe("GET /env-keys", () => {
  it("returns keys from the env file", async () => {
    vi.mocked(env.getEnvFileKeys).mockReturnValue(["DB_PASSWORD", "API_KEY"]);

    const res = await request(app).get("/env-keys");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: ["DB_PASSWORD", "API_KEY"] });
  });

  it("returns empty array when env file has no keys", async () => {
    vi.mocked(env.getEnvFileKeys).mockReturnValue([]);

    const res = await request(app).get("/env-keys");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: [] });
  });
});
