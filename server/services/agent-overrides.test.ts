import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:os", () => ({ default: { homedir: () => "/mock-home" } }));
vi.mock("node:url", () => ({
  fileURLToPath: () => "/projects/my-checkout/server/services/state.ts",
}));

const fsMocks = {
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
};
vi.mock("node:fs", () => ({ default: fsMocks }));

let mod: typeof import("./agent-overrides.js");

beforeEach(async () => {
  fsMocks.mkdirSync = vi.fn();
  fsMocks.existsSync = vi.fn();
  fsMocks.readFileSync = vi.fn();
  fsMocks.writeFileSync = vi.fn();
  fsMocks.renameSync = vi.fn();
  fsMocks.rmSync = vi.fn();

  process.env.ROUBO_PRODUCTION = "1";
  vi.resetModules();
  mod = await import("./agent-overrides.js");
});

afterEach(() => {
  delete process.env.ROUBO_PRODUCTION;
});

const AGENTS_DIR = "/mock-home/.roubo/agents/_global";

describe("loadAgentOverride", () => {
  it("returns null when the plugin has never been configured", () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(mod.loadAgentOverride("claude-code")).toBeNull();
  });

  it("reads the per-plugin file and returns the parsed envelope", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue("schemaVersion: 1\nconfig:\n  model: opus\n");
    expect(mod.loadAgentOverride("claude-code")).toEqual({
      schemaVersion: 1,
      config: { model: "opus" },
    });
    expect(fsMocks.readFileSync).toHaveBeenCalledWith(`${AGENTS_DIR}/claude-code.yaml`, "utf-8");
  });

  it("throws AgentOverrideError with code YAML_PARSE on malformed YAML", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(":\n  - bad\n  unbalanced");
    try {
      mod.loadAgentOverride("claude-code");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.AgentOverrideError);
      expect((err as InstanceType<typeof mod.AgentOverrideError>).code).toBe("YAML_PARSE");
    }
  });

  it("throws AgentOverrideError with code SCHEMA when the envelope is the wrong shape", () => {
    fsMocks.existsSync.mockReturnValue(true);
    // The integration envelope, not the agent one: `integration` is not `config`.
    fsMocks.readFileSync.mockReturnValue("schemaVersion: 1\nintegration:\n  plugin: github-com\n");
    try {
      mod.loadAgentOverride("claude-code");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(mod.AgentOverrideError);
      expect((err as InstanceType<typeof mod.AgentOverrideError>).code).toBe("SCHEMA");
    }
  });
});

describe("saveAgentConfig", () => {
  it("writes the envelope atomically to the plugin's own file", () => {
    mod.saveAgentConfig("claude-code", { model: "opus", effort: "high" });
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(AGENTS_DIR, { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      `${AGENTS_DIR}/claude-code.yaml.tmp`,
      expect.stringContaining("schemaVersion: 1"),
      expect.anything(),
    );
    expect(fsMocks.renameSync).toHaveBeenCalledWith(
      `${AGENTS_DIR}/claude-code.yaml.tmp`,
      `${AGENTS_DIR}/claude-code.yaml`,
    );
  });

  it("keeps two plugins' configs in separate files (AP-TC-003, AP-TC-009)", () => {
    mod.saveAgentConfig("claude-code", { model: "opus" });
    mod.saveAgentConfig("codex-cli", { model: "gpt-5" });

    const written = fsMocks.writeFileSync.mock.calls.map((call) => call[0] as string);
    expect(written).toEqual([
      `${AGENTS_DIR}/claude-code.yaml.tmp`,
      `${AGENTS_DIR}/codex-cli.yaml.tmp`,
    ]);
    expect(new Set(written).size).toBe(2);
  });

  it("keeps every file distinct across six installed agent plugins (AP-TC-015)", () => {
    const ids = ["agent-one", "agent-two", "agent-three", "agent-four", "agent-five", "agent-six"];
    for (const id of ids) mod.saveAgentConfig(id, { model: id });

    const written = fsMocks.writeFileSync.mock.calls.map((call) => call[0] as string);
    expect(new Set(written).size).toBe(ids.length);
    for (const id of ids) {
      expect(written).toContain(`${AGENTS_DIR}/${id}.yaml.tmp`);
    }
  });
});

describe("path guard", () => {
  const hostile = ["../escape", "..", ".hidden", "nested/id", "with space", ""];

  for (const pluginId of hostile) {
    it(`rejects the plugin id ${JSON.stringify(pluginId)} on every path`, () => {
      for (const call of [
        () => mod.loadAgentOverride(pluginId),
        () => mod.saveAgentConfig(pluginId, {}),
        () => mod.removeAgentConfig(pluginId),
      ]) {
        try {
          call();
          throw new Error(`expected throw for ${pluginId}`);
        } catch (err) {
          expect(err).toBeInstanceOf(mod.AgentOverrideError);
          expect((err as InstanceType<typeof mod.AgentOverrideError>).code).toBe(
            "INVALID_PLUGIN_ID",
          );
        }
      }
      expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
      expect(fsMocks.rmSync).not.toHaveBeenCalled();
    });
  }
});

describe("removeAgentConfig", () => {
  it("force-removes the plugin's file without checking existence", () => {
    mod.removeAgentConfig("claude-code");
    expect(fsMocks.rmSync).toHaveBeenCalledWith(`${AGENTS_DIR}/claude-code.yaml`, { force: true });
  });
});

describe("getEffectiveAgentConfig", () => {
  it("returns an empty record when nothing has been saved (AP-TC-012)", () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(mod.getEffectiveAgentConfig("claude-code")).toEqual({});
  });

  it("returns the saved config when the file is valid", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue("schemaVersion: 1\nconfig:\n  model: opus\n");
    expect(mod.getEffectiveAgentConfig("claude-code")).toEqual({ model: "opus" });
  });

  it("recovers to an empty record when the file is malformed", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(":\n  - bad\n  unbalanced");
    expect(mod.getEffectiveAgentConfig("claude-code")).toEqual({});
  });

  it("still rejects a hostile plugin id rather than swallowing it", () => {
    expect(() => mod.getEffectiveAgentConfig("../escape")).toThrow(mod.AgentOverrideError);
  });
});
