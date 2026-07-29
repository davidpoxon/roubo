import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { PluginManifest } from "@roubo/shared";

vi.mock("../services/project-registry.js");

vi.mock("../services/agent-plugin-registry.js", () => ({
  listAgents: vi.fn(),
  resolveAgent: vi.fn(),
  isAgentNotAvailable: (value: unknown) =>
    typeof value === "object" && value !== null && "reason" in value,
  describeAgentNotAvailable: (n: { reason: string; pluginId: string }) =>
    `Agent plugin "${n.pluginId}" is ${n.reason}.`,
}));

vi.mock("../services/agent-overrides.js", () => ({
  getEffectiveAgentConfig: vi.fn(),
}));

vi.mock("../services/agent-project-overrides.js", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-project-overrides.js")>(
    "../services/agent-project-overrides.js",
  );
  return {
    ...actual,
    resolveProjectAgentConfigs: vi.fn(),
    saveProjectAgentOverride: vi.fn(),
  };
});

import router from "./project-agents.js";
import * as projectRegistry from "../services/project-registry.js";
import * as registry from "../services/agent-plugin-registry.js";
import * as appOverrides from "../services/agent-overrides.js";
import * as projectOverrides from "../services/agent-project-overrides.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/projects", router);
  return a;
}

const CLAUDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    model: { type: "string", enum: ["sonnet", "opus", "haiku"] },
    effort: { type: "string", enum: ["low", "high"] },
    mode: { type: "string", enum: ["plan", "auto"] },
  },
};

const CODEX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { reasoningEffort: { type: "string", enum: ["low", "high"] } },
};

function manifest(id: string, name: string, configSchema: unknown): PluginManifest {
  return { id, name, version: "1.0.0", kind: "agent", configSchema } as PluginManifest;
}

// A schema with a required field: the only way an installed plugin can read as
// "not yet configured" (AP-TC-038). A schema with no required field accepts the
// empty config and is configured by definition.
const UNCONFIGURED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["apiKey"],
  properties: { apiKey: { type: "string" } },
};

const CLAUDE = manifest("claude-code", "Claude Code", CLAUDE_SCHEMA);
const CODEX = manifest("codex-cli", "Codex CLI", CODEX_SCHEMA);
// A distinct id: the validator cache is keyed by id@version, so reusing
// `codex-cli` here would validate one schema through the other's compiled
// validator.
const UNCONFIGURED = manifest("acme-agent", "Acme Agent", UNCONFIGURED_SCHEMA);

const APP_DEFAULTS = { model: "opus", effort: "high", mode: "plan" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    id: "roubo-development",
    repoPath: "/repo",
  } as never);
  vi.mocked(registry.listAgents).mockReturnValue([]);
  vi.mocked(registry.resolveAgent).mockImplementation(
    (pluginId: string) =>
      ({ pluginId, manifest: CLAUDE, connection: {} }) as ReturnType<typeof registry.resolveAgent>,
  );
  vi.mocked(appOverrides.getEffectiveAgentConfig).mockReturnValue(APP_DEFAULTS);
  vi.mocked(projectOverrides.resolveProjectAgentConfigs).mockReturnValue({
    resolved: [],
    orphaned: [],
  });
  vi.mocked(projectOverrides.saveProjectAgentOverride).mockImplementation((_p, _id, config) => ({
    schemaVersion: 1,
    config,
  }));
});

describe("GET /api/projects/:projectId/agents", () => {
  it("404s on an unregistered project", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined as never);
    const res = await request(app()).get("/api/projects/nope/agents");
    expect(res.status).toBe(404);
  });

  it("returns a clean empty list when no agent plugin is installed", async () => {
    const res = await request(app()).get("/api/projects/roubo-development/agents");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agents: [], orphanedOverrides: [] });
  });

  it("returns app defaults, the override subset, and the effective overlay (AP-TC-005)", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([CLAUDE]);
    vi.mocked(projectOverrides.resolveProjectAgentConfigs).mockReturnValue({
      resolved: [
        {
          pluginId: "claude-code",
          appDefaults: APP_DEFAULTS,
          overrides: { model: "sonnet" },
          effective: { model: "sonnet", effort: "high", mode: "plan" },
        },
      ],
      orphaned: [],
    });

    const res = await request(app()).get("/api/projects/roubo-development/agents");
    expect(res.status).toBe(200);
    expect(res.body.agents[0]).toMatchObject({
      id: "claude-code",
      name: "Claude Code",
      configSchema: CLAUDE_SCHEMA,
      appDefaults: APP_DEFAULTS,
      overrides: { model: "sonnet" },
      effective: { model: "sonnet", effort: "high", mode: "plan" },
      unavailable: null,
    });
  });

  it("flags an orphaned override without fabricating an agent for it (AP-TC-008)", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([CLAUDE]);
    vi.mocked(projectOverrides.resolveProjectAgentConfigs).mockReturnValue({
      resolved: [
        {
          pluginId: "claude-code",
          appDefaults: APP_DEFAULTS,
          overrides: {},
          effective: APP_DEFAULTS,
        },
      ],
      orphaned: [{ pluginId: "ghost-agent", reason: "not-installed" }],
    });

    const res = await request(app()).get("/api/projects/roubo-development/agents");
    expect(res.status).toBe(200);
    expect(res.body.orphanedOverrides).toEqual([
      { pluginId: "ghost-agent", reason: "not-installed" },
    ]);
    expect(res.body.agents.map((a: { id: string }) => a.id)).toEqual(["claude-code"]);
    expect(res.body.agents[0].effective).toEqual(APP_DEFAULTS);
  });

  it("keeps an unresolvable agent visible with its blocker named", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([CLAUDE]);
    vi.mocked(registry.resolveAgent).mockReturnValue({
      reason: "not-consented",
      pluginId: "claude-code",
    });

    const res = await request(app()).get("/api/projects/roubo-development/agents");
    expect(res.body.agents[0].unavailable).toEqual({
      reason: "not-consented",
      message: 'Agent plugin "claude-code" is not-consented.',
    });
  });

  it("reports a valid effective config as configured (AP-TC-038)", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([CLAUDE]);
    vi.mocked(projectOverrides.resolveProjectAgentConfigs).mockReturnValue({
      resolved: [
        {
          pluginId: "claude-code",
          appDefaults: APP_DEFAULTS,
          overrides: {},
          effective: APP_DEFAULTS,
        },
      ],
      orphaned: [],
    });

    const res = await request(app()).get("/api/projects/roubo-development/agents");
    expect(res.body.agents[0].misconfigured).toBeNull();
  });

  it("flags an installed-but-unconfigured agent with the offending field (AP-TC-038)", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([UNCONFIGURED]);
    vi.mocked(projectOverrides.resolveProjectAgentConfigs).mockReturnValue({
      resolved: [{ pluginId: "acme-agent", appDefaults: {}, overrides: {}, effective: {} }],
      orphaned: [],
    });

    const res = await request(app()).get("/api/projects/roubo-development/agents");
    expect(res.body.agents[0].unavailable).toBeNull();
    expect(res.body.agents[0].misconfigured.message).toContain("apiKey");
  });
});

describe("PUT /api/projects/:projectId/agents/:pluginId/config", () => {
  beforeEach(() => {
    vi.mocked(registry.listAgents).mockReturnValue([CLAUDE, CODEX]);
  });

  it("persists an override subset and returns the effective overlay", async () => {
    const res = await request(app())
      .put("/api/projects/roubo-development/agents/claude-code/config")
      .send({ config: { model: "sonnet" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projectId: "roubo-development",
      pluginId: "claude-code",
      overrides: { model: "sonnet" },
      effective: { model: "sonnet", effort: "high", mode: "plan" },
    });
    expect(projectOverrides.saveProjectAgentOverride).toHaveBeenCalledWith(
      "roubo-development",
      "claude-code",
      { model: "sonnet" },
    );
  });

  it("clears every override for the plugin on an empty config (AP-TC-005 S004)", async () => {
    const res = await request(app())
      .put("/api/projects/roubo-development/agents/claude-code/config")
      .send({ config: {} });

    expect(res.status).toBe(200);
    expect(res.body.overrides).toEqual({});
    expect(res.body.effective).toEqual(APP_DEFAULTS);
  });

  it("rejects an out-of-enum override value host-side, naming the allowed values", async () => {
    const res = await request(app())
      .put("/api/projects/roubo-development/agents/claude-code/config")
      .send({ config: { model: "gpt-5" } });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toEqual([
      { path: "model", message: "Must be one of: sonnet, opus, haiku" },
    ]);
    expect(projectOverrides.saveProjectAgentOverride).not.toHaveBeenCalled();
  });

  it("validates against the addressed plugin's schema only", async () => {
    const rejected = await request(app())
      .put("/api/projects/roubo-development/agents/claude-code/config")
      .send({ config: { reasoningEffort: "high" } });
    expect(rejected.status).toBe(400);

    vi.mocked(appOverrides.getEffectiveAgentConfig).mockReturnValue({});
    const accepted = await request(app())
      .put("/api/projects/roubo-development/agents/codex-cli/config")
      .send({ config: { reasoningEffort: "high" } });
    expect(accepted.status).toBe(200);
  });

  it("404s on an unregistered project before any write", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined as never);
    const res = await request(app())
      .put("/api/projects/nope/agents/claude-code/config")
      .send({ config: {} });
    expect(res.status).toBe(404);
    expect(projectOverrides.saveProjectAgentOverride).not.toHaveBeenCalled();
  });

  it("400s on a malformed plugin id before any write", async () => {
    const res = await request(app())
      .put("/api/projects/roubo-development/agents/Bad_Id/config")
      .send({ config: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid plugin id");
    expect(projectOverrides.saveProjectAgentOverride).not.toHaveBeenCalled();
  });

  it("404s on an id that is not an installed agent plugin (AP-TC-008)", async () => {
    const res = await request(app())
      .put("/api/projects/roubo-development/agents/ghost-agent/config")
      .send({ config: { model: "sonnet" } });
    expect(res.status).toBe(404);
    expect(projectOverrides.saveProjectAgentOverride).not.toHaveBeenCalled();
  });

  it("400s on a body that is not { config: object }", async () => {
    const res = await request(app())
      .put("/api/projects/roubo-development/agents/claude-code/config")
      .send({ model: "sonnet" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid body: { config: object } required");
  });
});
