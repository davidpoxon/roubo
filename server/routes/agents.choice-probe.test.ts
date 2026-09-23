import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PluginManifest } from "@roubo/shared";

// The choice probe end to end through GET /api/agents (APCC-TC-024).
// agents.test.ts mocks the runner's route-facing calls for the whole file, so the
// sequence that needs the REAL warm, cache and read lives here. Only the spawn is
// stubbed, so each case decides what the CLI prints without running one.

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
  return { ...actual, getEffectiveAgentConfig: vi.fn() };
});

vi.mock("../services/probe-spawn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/probe-spawn.js")>();
  return { ...actual, spawnProbe: vi.fn() };
});

import router from "./agents.js";
import * as registry from "../services/agent-plugin-registry.js";
import * as overrides from "../services/agent-overrides.js";
import { DETECTION_TTL_MS, resetProbeRunnerCache } from "../services/agent-probe-runner.js";
import { spawnProbe } from "../services/probe-spawn.js";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/agents", router);
  return a;
}

const DECLARED_MODEL = { type: "string", title: "Model" };

// A path-shaped command resolves without a PATH fixture, and no
// `agentCompatibility` means no version probe shares the spawn stub.
const CURSOR = {
  id: "cursor-cli",
  name: "Cursor CLI",
  version: "1.0.0",
  kind: "agent",
  configSchema: { type: "object", properties: { model: DECLARED_MODEL } },
  choiceProbes: {
    model: { command: process.execPath, args: ["--list-models"], parse: "dash-line-pairs" },
  },
} as PluginManifest;

async function readModel() {
  const res = await request(app()).get("/api/agents");
  expect(res.status).toBe(200);
  return {
    probe: res.body.agents[0].choiceProbes.model,
    property: res.body.agents[0].configSchema.properties.model,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProbeRunnerCache();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.mocked(registry.listAgents).mockReturnValue([CURSOR]);
  vi.mocked(registry.resolveAgent).mockImplementation(
    (pluginId: string) =>
      ({ pluginId, manifest: CURSOR, connection: {} }) as ReturnType<typeof registry.resolveAgent>,
  );
  vi.mocked(overrides.getEffectiveAgentConfig).mockReturnValue({});
  vi.mocked(spawnProbe).mockResolvedValue({
    code: 0,
    stdout: "m-alpha - Alpha\nm-beta - Beta",
    stderr: "",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/agents choice probe cache window (APCC-TC-024)", () => {
  it("never serves an expired list once the CLI fails, and reports the failure on the same open", async () => {
    await vi.waitFor(async () => expect((await readModel()).probe).toEqual({ state: "resolved" }));
    expect((await readModel()).property.oneOf).toEqual([
      { const: "m-alpha", title: "Alpha" },
      { const: "m-beta", title: "Beta" },
    ]);

    // Reopen past the window with the CLI now failing.
    vi.setSystemTime(Date.now() + DETECTION_TTL_MS + 1000);
    vi.mocked(spawnProbe).mockResolvedValue({ code: 1, stdout: "", stderr: "offline" });

    // The first read must not answer with the list the expired run resolved. It
    // reports loading, which is what keeps the client polling on this open.
    const first = await readModel();
    expect(first.probe).toEqual({ state: "loading" });
    expect(first.property).toEqual(DECLARED_MODEL);

    // The client's next poll picks up the failure without a reopen.
    await vi.waitFor(async () => expect((await readModel()).probe.state).toBe("failed"));
    const settled = await readModel();
    expect(settled.probe).toMatchObject({ state: "failed", cause: "probe-error" });
    expect(settled.probe.reason).toContain("offline");
    expect(settled.property).toEqual(DECLARED_MODEL);
  });

  it("serves the re-probed list, not the expired one, when the CLI still answers", async () => {
    await vi.waitFor(async () => expect((await readModel()).probe).toEqual({ state: "resolved" }));

    vi.setSystemTime(Date.now() + DETECTION_TTL_MS + 1000);
    vi.mocked(spawnProbe).mockResolvedValue({ code: 0, stdout: "m-gamma - Gamma", stderr: "" });

    expect((await readModel()).probe).toEqual({ state: "loading" });
    await vi.waitFor(async () => expect((await readModel()).probe).toEqual({ state: "resolved" }));
    expect((await readModel()).property.oneOf).toEqual([{ const: "m-gamma", title: "Gamma" }]);
    expect(spawnProbe).toHaveBeenCalledTimes(2);
  });

  it("spawns the command once for two opens inside the window", async () => {
    await vi.waitFor(async () => expect((await readModel()).probe).toEqual({ state: "resolved" }));
    const again = await readModel();

    expect(again.probe).toEqual({ state: "resolved" });
    expect(again.property.oneOf).toHaveLength(2);
    expect(spawnProbe).toHaveBeenCalledTimes(1);
  });
});
