import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginManifest } from "@roubo/shared";

vi.mock("node:os", () => ({ default: { homedir: () => "/mock-home" } }));
vi.mock("node:url", () => ({
  fileURLToPath: () => "/projects/my-checkout/server/services/state.ts",
}));

const fsMocks = {
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
};
vi.mock("node:fs", () => ({ default: fsMocks }));

let mod: typeof import("./agent-project-overrides.js");

const AGENTS_DIR = "/mock-home/.roubo/agents";
const GLOBAL_DIR = `${AGENTS_DIR}/_global`;
const PROJECT_DIR = `${AGENTS_DIR}/roubo-development`;

/** App defaults for AP-TC-005 / AP-TC-010 / AP-TC-016: model/effort/mode. */
const APP_DEFAULTS = { model: "opus", effort: "high", mode: "plan" };
const OVERRIDE_VALUES = { model: "sonnet", effort: "low", mode: "auto" };

function manifest(id: string, name = id): PluginManifest {
  return { id, name, version: "1.0.0", kind: "agent" } as PluginManifest;
}

/**
 * Wires the mocked filesystem so `_global/<id>.yaml` and
 * `<projectId>/<id>.yaml` return the supplied records and every other path
 * reads as absent.
 */
function withFiles(files: Record<string, Record<string, unknown>>, dirEntries?: string[]) {
  fsMocks.existsSync.mockImplementation((p: string) => p in files || p === PROJECT_DIR);
  fsMocks.readFileSync.mockImplementation((p: string) => {
    const config = files[p as string];
    if (!config) throw new Error(`unexpected read: ${p}`);
    return `schemaVersion: 1\nconfig:\n${Object.entries(config)
      .map(([k, v]) => `  ${k}: ${String(v)}`)
      .join("\n")}\n`;
  });
  fsMocks.readdirSync.mockReturnValue(dirEntries ?? []);
}

beforeEach(async () => {
  fsMocks.mkdirSync = vi.fn();
  fsMocks.existsSync = vi.fn().mockReturnValue(false);
  fsMocks.readFileSync = vi.fn();
  fsMocks.readdirSync = vi.fn().mockReturnValue([]);
  fsMocks.writeFileSync = vi.fn();
  fsMocks.renameSync = vi.fn();
  fsMocks.rmSync = vi.fn();

  process.env.ROUBO_PRODUCTION = "1";
  vi.resetModules();
  mod = await import("./agent-project-overrides.js");
});

afterEach(() => {
  delete process.env.ROUBO_PRODUCTION;
});

describe("resolveProjectAgentPath", () => {
  it("keys the file by project id and plugin id", () => {
    expect(mod.resolveProjectAgentPath("roubo-development", "claude-code")).toBe(
      `${PROJECT_DIR}/claude-code.yaml`,
    );
  });

  it("keeps two projects' overrides of the same plugin in separate files", () => {
    const a = mod.resolveProjectAgentPath("project-a", "claude-code");
    const b = mod.resolveProjectAgentPath("project-b", "claude-code");
    expect(a).not.toBe(b);
  });

  it("keeps two plugins' overrides in the same project in separate files", () => {
    const a = mod.resolveProjectAgentPath("roubo-development", "claude-code");
    const b = mod.resolveProjectAgentPath("roubo-development", "codex-cli");
    expect(a).not.toBe(b);
  });

  it("never collides with the app-level _global namespace", () => {
    // `_global` starts with an underscore, which SAFE_PROJECT_ID accepts, so
    // the guard alone does not separate the namespaces. What does is that a
    // projectId is a registered project's name, which ProjectConfigSchema
    // constrains to /^[a-z0-9-]+$/, so a project literally named `_global`
    // cannot be registered and can never reach this path.
    expect(mod.resolveProjectAgentPath("roubo-development", "claude-code")).not.toContain(
      GLOBAL_DIR,
    );
  });
});

describe("path guard", () => {
  const hostile = ["../escape", "..", ".hidden", "nested/id", "with space", ""];

  for (const projectId of hostile) {
    it(`rejects the project id ${JSON.stringify(projectId)}`, () => {
      for (const call of [
        () => mod.loadProjectAgentOverride(projectId, "claude-code"),
        () => mod.saveProjectAgentOverride(projectId, "claude-code", { model: "sonnet" }),
        () => mod.removeProjectAgentOverride(projectId, "claude-code"),
        () => mod.listProjectOverridePluginIds(projectId),
      ]) {
        try {
          call();
          throw new Error(`expected throw for ${projectId}`);
        } catch (err) {
          expect(err).toBeInstanceOf(mod.AgentProjectOverrideError);
          expect((err as InstanceType<typeof mod.AgentProjectOverrideError>).code).toBe(
            "INVALID_PROJECT_ID",
          );
        }
      }
      expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
      expect(fsMocks.rmSync).not.toHaveBeenCalled();
    });
  }

  for (const pluginId of hostile) {
    it(`rejects the plugin id ${JSON.stringify(pluginId)}`, () => {
      for (const call of [
        () => mod.loadProjectAgentOverride("roubo-development", pluginId),
        () => mod.saveProjectAgentOverride("roubo-development", pluginId, { model: "sonnet" }),
        () => mod.removeProjectAgentOverride("roubo-development", pluginId),
      ]) {
        try {
          call();
          throw new Error(`expected throw for ${pluginId}`);
        } catch (err) {
          expect(err).toBeInstanceOf(mod.AgentProjectOverrideError);
          expect((err as InstanceType<typeof mod.AgentProjectOverrideError>).code).toBe(
            "INVALID_PLUGIN_ID",
          );
        }
      }
      expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
      expect(fsMocks.rmSync).not.toHaveBeenCalled();
    });
  }
});

describe("loadProjectAgentOverride", () => {
  it("returns null when the project overrides nothing for that plugin", () => {
    expect(mod.loadProjectAgentOverride("roubo-development", "claude-code")).toBeNull();
  });

  it("returns only the overridden fields, not a whole config", () => {
    withFiles({ [`${PROJECT_DIR}/claude-code.yaml`]: { model: "sonnet" } });
    expect(mod.loadProjectAgentOverride("roubo-development", "claude-code")).toEqual({
      schemaVersion: 1,
      config: { model: "sonnet" },
    });
  });

  it("throws with code YAML_PARSE on malformed YAML", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(":\n  - bad\n  unbalanced");
    try {
      mod.loadProjectAgentOverride("roubo-development", "claude-code");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as InstanceType<typeof mod.AgentProjectOverrideError>).code).toBe("YAML_PARSE");
    }
  });

  it("throws with code SCHEMA when the envelope is the wrong shape", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue("schemaVersion: 1\nintegration:\n  plugin: github-com\n");
    try {
      mod.loadProjectAgentOverride("roubo-development", "claude-code");
      throw new Error("expected throw");
    } catch (err) {
      expect((err as InstanceType<typeof mod.AgentProjectOverrideError>).code).toBe("SCHEMA");
    }
  });
});

describe("getProjectAgentOverrides", () => {
  it("returns an empty record when the project overrides nothing for that plugin", () => {
    expect(mod.getProjectAgentOverrides("roubo-development", "claude-code")).toEqual({});
  });

  it("returns just the stored override subset", () => {
    withFiles({ [`${PROJECT_DIR}/claude-code.yaml`]: { model: "sonnet" } });
    expect(mod.getProjectAgentOverrides("roubo-development", "claude-code")).toEqual({
      model: "sonnet",
    });
  });

  it("degrades a malformed file to inheriting everything rather than throwing", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(":\n  - bad\n  unbalanced");
    expect(mod.getProjectAgentOverrides("roubo-development", "claude-code")).toEqual({});
  });

  it("degrades a schema-invalid envelope the same way", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue("schemaVersion: 1\nintegration:\n  plugin: github-com\n");
    expect(mod.getProjectAgentOverrides("roubo-development", "claude-code")).toEqual({});
  });

  it("still throws on a rejected id, which is an input error, not a recoverable state", () => {
    expect(() => mod.getProjectAgentOverrides("../escape", "claude-code")).toThrow(
      mod.AgentProjectOverrideError,
    );
    expect(() => mod.getProjectAgentOverrides("roubo-development", "../escape")).toThrow(
      mod.AgentProjectOverrideError,
    );
  });
});

describe("saveProjectAgentOverride", () => {
  it("writes the override subset atomically to the project's own file", () => {
    mod.saveProjectAgentOverride("roubo-development", "claude-code", { model: "sonnet" });
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(PROJECT_DIR, { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      `${PROJECT_DIR}/claude-code.yaml.tmp`,
      expect.stringContaining("model: sonnet"),
      expect.anything(),
    );
    expect(fsMocks.renameSync).toHaveBeenCalledWith(
      `${PROJECT_DIR}/claude-code.yaml.tmp`,
      `${PROJECT_DIR}/claude-code.yaml`,
    );
  });

  it("removes the file rather than writing an empty envelope when nothing is overridden", () => {
    mod.saveProjectAgentOverride("roubo-development", "claude-code", {});
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
    expect(fsMocks.rmSync).toHaveBeenCalledWith(`${PROJECT_DIR}/claude-code.yaml`, { force: true });
  });

  it("keeps two projects' saves in separate files", () => {
    mod.saveProjectAgentOverride("project-a", "claude-code", { model: "sonnet" });
    mod.saveProjectAgentOverride("project-b", "claude-code", { model: "haiku" });
    const written = fsMocks.writeFileSync.mock.calls.map((call) => call[0] as string);
    expect(new Set(written).size).toBe(2);
  });
});

describe("listProjectOverridePluginIds", () => {
  it("returns nothing when the project has no override directory", () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(mod.listProjectOverridePluginIds("roubo-development")).toEqual([]);
  });

  it("lists the plugin ids the project has override files for", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readdirSync.mockReturnValue([
      "codex-cli.yaml",
      "claude-code.yaml",
      "claude-code.yaml.tmp",
      "notes.txt",
    ]);
    expect(mod.listProjectOverridePluginIds("roubo-development")).toEqual([
      "claude-code",
      "codex-cli",
    ]);
  });
});

describe("mergeAgentConfig (AP-TC-005, AP-TC-016)", () => {
  it("overlays app defaults per field, leaving the rest inheriting (AP-TC-005 S002/S003)", () => {
    expect(mod.mergeAgentConfig(APP_DEFAULTS, { model: "sonnet" })).toEqual({
      model: "sonnet",
      effort: "high",
      mode: "plan",
    });
  });

  it("returns the app defaults exactly when the override is toggled off (AP-TC-005 S004)", () => {
    expect(mod.mergeAgentConfig(APP_DEFAULTS, {})).toEqual(APP_DEFAULTS);
  });

  it("returns the fully-overridden set when every field is overridden (AP-TC-010 S001)", () => {
    expect(mod.mergeAgentConfig(APP_DEFAULTS, OVERRIDE_VALUES)).toEqual(OVERRIDE_VALUES);
  });

  it("tracks a later app-default change on inherited fields (AP-TC-010 S003)", () => {
    const changed = { ...APP_DEFAULTS, model: "haiku" };
    expect(mod.mergeAgentConfig(changed, {})).toEqual({
      model: "haiku",
      effort: "high",
      mode: "plan",
    });
  });

  it("resolves all eight override subsets exactly (AP-TC-016 S001)", () => {
    const fields = ["model", "effort", "mode"] as const;
    for (let mask = 0; mask < 8; mask++) {
      const overrides: Record<string, unknown> = {};
      const expected: Record<string, unknown> = { ...APP_DEFAULTS };
      fields.forEach((field, index) => {
        if (mask & (1 << index)) {
          overrides[field] = OVERRIDE_VALUES[field];
          expected[field] = OVERRIDE_VALUES[field];
        }
      });
      expect(mod.mergeAgentConfig(APP_DEFAULTS, overrides)).toEqual(expected);
    }
  });

  it("holds an overridden field fixed while an inherited one tracks (AP-TC-016 S002)", () => {
    const overrides = { model: "sonnet" };
    const before = mod.mergeAgentConfig(APP_DEFAULTS, overrides);
    const after = mod.mergeAgentConfig({ ...APP_DEFAULTS, effort: "low" }, overrides);
    expect(before.model).toBe("sonnet");
    expect(after.model).toBe("sonnet");
    expect(before.effort).toBe("high");
    expect(after.effort).toBe("low");
  });

  it("touches no filesystem (AP-TC-048: resolution stays pure)", () => {
    mod.mergeAgentConfig(APP_DEFAULTS, { model: "sonnet" });
    expect(fsMocks.readFileSync).not.toHaveBeenCalled();
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not mutate either input record", () => {
    const defaults = { ...APP_DEFAULTS };
    const overrides = { model: "sonnet" };
    mod.mergeAgentConfig(defaults, overrides);
    expect(defaults).toEqual(APP_DEFAULTS);
    expect(overrides).toEqual({ model: "sonnet" });
  });
});

describe("resolveProjectAgentConfigs", () => {
  it("resolves each installed plugin's two layers into an effective config", () => {
    withFiles(
      {
        [`${GLOBAL_DIR}/claude-code.yaml`]: APP_DEFAULTS,
        [`${PROJECT_DIR}/claude-code.yaml`]: { model: "sonnet" },
      },
      ["claude-code.yaml"],
    );

    const { resolved, orphaned } = mod.resolveProjectAgentConfigs("roubo-development", [
      manifest("claude-code", "Claude Code"),
    ]);

    expect(orphaned).toEqual([]);
    expect(resolved).toEqual([
      {
        pluginId: "claude-code",
        appDefaults: APP_DEFAULTS,
        overrides: { model: "sonnet" },
        effective: { model: "sonnet", effort: "high", mode: "plan" },
      },
    ]);
  });

  it("flags an override for an uninstalled plugin and fabricates nothing (AP-TC-008)", () => {
    withFiles(
      {
        [`${GLOBAL_DIR}/claude-code.yaml`]: APP_DEFAULTS,
        [`${PROJECT_DIR}/claude-code.yaml`]: { model: "sonnet" },
        [`${PROJECT_DIR}/ghost-agent.yaml`]: { model: "phantom" },
      },
      ["claude-code.yaml", "ghost-agent.yaml"],
    );

    const { resolved, orphaned } = mod.resolveProjectAgentConfigs("roubo-development", [
      manifest("claude-code", "Claude Code"),
    ]);

    expect(orphaned).toEqual([{ pluginId: "ghost-agent", reason: "not-installed" }]);
    // No effective config is synthesised for the missing plugin ...
    expect(resolved.map((r) => r.pluginId)).toEqual(["claude-code"]);
    // ... and the installed plugin's effective config is unaffected.
    expect(resolved[0].effective).toEqual({ model: "sonnet", effort: "high", mode: "plan" });
  });

  it("treats an installed but never-configured plugin as app defaults of {}", () => {
    withFiles({ [`${PROJECT_DIR}/claude-code.yaml`]: { model: "sonnet" } }, ["claude-code.yaml"]);

    const { resolved, orphaned } = mod.resolveProjectAgentConfigs("roubo-development", [
      manifest("claude-code", "Claude Code"),
    ]);

    expect(orphaned).toEqual([]);
    expect(resolved[0]).toEqual({
      pluginId: "claude-code",
      appDefaults: {},
      overrides: { model: "sonnet" },
      effective: { model: "sonnet" },
    });
  });

  it("degrades one unreadable override file to 'inherits everything'", () => {
    fsMocks.existsSync.mockImplementation((p: string) => p !== `${GLOBAL_DIR}/claude-code.yaml`);
    fsMocks.readFileSync.mockReturnValue(":\n  - bad\n  unbalanced");
    fsMocks.readdirSync.mockReturnValue(["claude-code.yaml"]);

    const { resolved } = mod.resolveProjectAgentConfigs("roubo-development", [
      manifest("claude-code", "Claude Code"),
    ]);
    expect(resolved[0].overrides).toEqual({});
  });

  it("returns a clean empty result when no agent plugin is installed", () => {
    expect(mod.resolveProjectAgentConfigs("roubo-development", [])).toEqual({
      resolved: [],
      orphaned: [],
    });
  });
});
