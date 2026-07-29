import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { PluginManifest } from "@roubo/shared";

vi.mock("../services/agent-plugin-registry.js", () => ({
  listAgents: vi.fn(),
  resolveAgent: vi.fn(),
  isAgentNotAvailable: (value: unknown) =>
    typeof value === "object" && value !== null && "reason" in value,
  describeAgentNotAvailable: (n: { reason: string; pluginId: string }) =>
    `Agent plugin "${n.pluginId}" is ${n.reason}.`,
}));

vi.mock("../services/agent-overrides.js", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-overrides.js")>(
    "../services/agent-overrides.js",
  );
  return {
    ...actual,
    getEffectiveAgentConfig: vi.fn(),
    saveAgentConfig: vi.fn(),
  };
});

import router from "./agents.js";
import * as registry from "../services/agent-plugin-registry.js";
import * as overrides from "../services/agent-overrides.js";
import { probeAgentVersion, resetAgentVersionProbeCache } from "../services/agent-version-probe.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/agents", router);
  return a;
}

const CLAUDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { model: { type: "string", enum: ["sonnet", "opus"] } },
};

const CODEX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { reasoningEffort: { type: "string", enum: ["low", "high"] } },
};

function manifest(id: string, name: string, configSchema: unknown): PluginManifest {
  return { id, name, version: "1.0.0", kind: "agent", configSchema } as PluginManifest;
}

const CLAUDE = manifest("claude-code", "Claude Code", CLAUDE_SCHEMA);
const CODEX = manifest("codex-cli", "Codex CLI", CODEX_SCHEMA);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(registry.listAgents).mockReturnValue([]);
  vi.mocked(registry.resolveAgent).mockImplementation(
    (pluginId: string) =>
      ({ pluginId, manifest: CLAUDE, connection: {} }) as ReturnType<typeof registry.resolveAgent>,
  );
  vi.mocked(overrides.getEffectiveAgentConfig).mockReturnValue({});
  vi.mocked(overrides.saveAgentConfig).mockImplementation((_id, config) => ({
    schemaVersion: 1,
    config,
  }));
  resetAgentVersionProbeCache();
});

describe("GET /api/agents", () => {
  it("returns a clean empty list when no agent plugin is installed (AP-TC-012)", async () => {
    const res = await request(app()).get("/api/agents");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agents: [] });
  });

  it("returns each installed agent with its own schema and saved config (AP-TC-004)", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([CLAUDE, CODEX]);
    vi.mocked(overrides.getEffectiveAgentConfig).mockImplementation((id: string) =>
      id === "claude-code" ? { model: "opus" } : { reasoningEffort: "high" },
    );

    const res = await request(app()).get("/api/agents");
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.agents[0]).toMatchObject({
      id: "claude-code",
      name: "Claude Code",
      configSchema: CLAUDE_SCHEMA,
      config: { model: "opus" },
      unavailable: null,
    });
    expect(res.body.agents[1]).toMatchObject({
      id: "codex-cli",
      configSchema: CODEX_SCHEMA,
      config: { reasoningEffort: "high" },
    });
  });

  it("keeps an unresolvable agent visible with its blocker named", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([CLAUDE]);
    vi.mocked(registry.resolveAgent).mockReturnValue({
      reason: "not-consented",
      pluginId: "claude-code",
    });

    const res = await request(app()).get("/api/agents");
    expect(res.body.agents[0].unavailable).toEqual({
      reason: "not-consented",
      message: 'Agent plugin "claude-code" is not-consented.',
    });
  });
});

describe("GET /api/agents/:id/config", () => {
  it("returns the saved config for an installed agent", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([CLAUDE]);
    vi.mocked(overrides.getEffectiveAgentConfig).mockReturnValue({ model: "opus" });

    const res = await request(app()).get("/api/agents/claude-code/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pluginId: "claude-code", config: { model: "opus" } });
  });

  it("400s on a malformed plugin id", async () => {
    const res = await request(app()).get("/api/agents/Not_An_Id/config");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid plugin id");
  });

  it("404s on an id that is not an installed agent plugin", async () => {
    const res = await request(app()).get("/api/agents/nope/config");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unknown agent plugin: nope");
  });
});

describe("PUT /api/agents/:id/config", () => {
  beforeEach(() => {
    vi.mocked(registry.listAgents).mockReturnValue([CLAUDE, CODEX]);
  });

  it("persists a valid config against the plugin's own file", async () => {
    const res = await request(app())
      .put("/api/agents/claude-code/config")
      .send({ config: { model: "opus" } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ pluginId: "claude-code", config: { model: "opus" } });
    expect(overrides.saveAgentConfig).toHaveBeenCalledWith("claude-code", { model: "opus" });
  });

  it("rejects an out-of-enum value, naming the field and allowed values (AP-TC-011)", async () => {
    const res = await request(app())
      .put("/api/agents/claude-code/config")
      .send({ config: { model: "gpt-5" } });

    expect(res.status).toBe(400);
    expect(res.body.fieldErrors).toEqual([
      { path: "model", message: "Must be one of: sonnet, opus" },
    ]);
    expect(overrides.saveAgentConfig).not.toHaveBeenCalled();
  });

  it("validates against the addressed plugin's schema only (AP-TC-003)", async () => {
    // `reasoningEffort` is Codex's field, not Claude Code's.
    const rejected = await request(app())
      .put("/api/agents/claude-code/config")
      .send({ config: { reasoningEffort: "high" } });
    expect(rejected.status).toBe(400);

    const accepted = await request(app())
      .put("/api/agents/codex-cli/config")
      .send({ config: { reasoningEffort: "high" } });
    expect(accepted.status).toBe(200);
    expect(overrides.saveAgentConfig).toHaveBeenCalledWith("codex-cli", {
      reasoningEffort: "high",
    });
  });

  it("writes each plugin to its own id under interleaved saves (AP-TC-009)", async () => {
    await request(app())
      .put("/api/agents/claude-code/config")
      .send({ config: { model: "opus" } });
    await request(app())
      .put("/api/agents/codex-cli/config")
      .send({ config: { reasoningEffort: "low" } });
    await request(app())
      .put("/api/agents/claude-code/config")
      .send({ config: { model: "sonnet" } });

    expect(vi.mocked(overrides.saveAgentConfig).mock.calls).toEqual([
      ["claude-code", { model: "opus" }],
      ["codex-cli", { reasoningEffort: "low" }],
      ["claude-code", { model: "sonnet" }],
    ]);
  });

  it("400s on a body that is not { config: object }", async () => {
    const res = await request(app()).put("/api/agents/claude-code/config").send({ model: "opus" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid body: { config: object } required");
  });

  it("400s on a malformed plugin id before any write", async () => {
    const res = await request(app()).put("/api/agents/Bad_Id/config").send({ config: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid plugin id");
    expect(overrides.saveAgentConfig).not.toHaveBeenCalled();
  });

  it("404s on an id that is not an installed agent plugin", async () => {
    const res = await request(app()).put("/api/agents/nope/config").send({ config: {} });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/agents compatibility block (AP-TC-113, AP-TC-114)", () => {
  const PROBE = {
    args: ["--version"],
    parse: "semver" as const,
    minVersion: "2.1.111",
    testedCeiling: "2.1.205",
  };

  function withCompatibility(min?: string, ceiling?: string): PluginManifest {
    return {
      ...CLAUDE,
      agentCompatibility: {
        ...(min !== undefined && { minVersion: min }),
        ...(ceiling !== undefined && { testedCeiling: ceiling }),
      },
    } as PluginManifest;
  }

  it("renders the declared window with status unknown before any launch has probed", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([withCompatibility("2.1.111", "2.1.205")]);

    const res = await request(app()).get("/api/agents");

    expect(res.body.agents[0].compatibility).toEqual({
      minVersion: "2.1.111",
      testedCeiling: "2.1.205",
      status: "unknown",
    });
  });

  it("adds the detected version and its verdict once a probe has run, without re-probing", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([withCompatibility("2.1.111", "2.1.205")]);
    // A launch probed the CLI at some earlier point; the route reads the cache.
    await probeAgentVersion("claude-code", "/bin/echo", { ...PROBE, args: ["2.1.207"] });

    const res = await request(app()).get("/api/agents");

    expect(res.body.agents[0].compatibility).toMatchObject({
      detectedVersion: "2.1.207",
      testedCeiling: "2.1.205",
      status: "above-tested-ceiling",
    });
  });

  it("warms a detected version from the manifest probe, with no launch (AP-TC-113)", async () => {
    const manifest = {
      ...withCompatibility("2.1.111", "2.1.205"),
      agentCompatibility: {
        minVersion: "2.1.111",
        testedCeiling: "2.1.205",
        probe: { command: "/bin/echo", args: ["2.1.180"], parse: "semver" as const },
      },
    } as PluginManifest;
    vi.mocked(registry.listAgents).mockReturnValue([manifest]);

    // First read kicks the warm off in the background and answers from cache, so
    // the route never blocks on a spawn.
    await request(app()).get("/api/agents");
    await vi.waitFor(async () => {
      const res = await request(app()).get("/api/agents");
      expect(res.body.agents[0].compatibility).toMatchObject({
        detectedVersion: "2.1.180",
        status: "within-tested-range",
      });
    });
  });

  it("never probes an agent the host refuses to run", async () => {
    const manifest = {
      ...CLAUDE,
      agentCompatibility: {
        minVersion: "2.1.111",
        // A command that would be observable if it were ever spawned.
        probe: { command: "/bin/echo", args: ["9.9.9"], parse: "semver" as const },
      },
    } as PluginManifest;
    vi.mocked(registry.listAgents).mockReturnValue([manifest]);
    vi.mocked(registry.resolveAgent).mockReturnValue({
      reason: "not-consented",
      pluginId: "claude-code",
    } as ReturnType<typeof registry.resolveAgent>);

    await request(app()).get("/api/agents");
    // Give any (incorrectly) scheduled warm a chance to land before asserting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await request(app()).get("/api/agents");

    expect(res.body.agents[0].unavailable).toMatchObject({ reason: "not-consented" });
    // The declared floor still renders; only the detection is withheld.
    expect(res.body.agents[0].compatibility).toEqual({
      minVersion: "2.1.111",
      status: "unknown",
    });
  });

  it("omits the block entirely for an agent that declares nothing and was never probed", async () => {
    vi.mocked(registry.listAgents).mockReturnValue([CODEX]);

    const res = await request(app()).get("/api/agents");

    expect(res.body.agents[0].compatibility).toBeUndefined();
  });
});
