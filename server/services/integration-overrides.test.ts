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
};
vi.mock("node:fs", () => ({ default: fsMocks }));

let mod: typeof import("./integration-overrides.js");

beforeEach(async () => {
  fsMocks.mkdirSync = vi.fn();
  fsMocks.existsSync = vi.fn();
  fsMocks.readFileSync = vi.fn();
  fsMocks.writeFileSync = vi.fn();
  fsMocks.renameSync = vi.fn();

  process.env.ROUBO_PRODUCTION = "1";
  vi.resetModules();
  mod = await import("./integration-overrides.js");
});

afterEach(() => {
  delete process.env.ROUBO_PRODUCTION;
});

const OVERRIDES_DIR = "/mock-home/.roubo/integrations";

describe("loadOverride", () => {
  it("returns null when no override file exists", () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(mod.loadOverride("my-project")).toBeNull();
  });

  it("returns the parsed envelope when the file is valid", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      "schemaVersion: 1\nintegration:\n  plugin: github-com\n  sources:\n    boards: [99]\n",
    );
    expect(mod.loadOverride("my-project")).toEqual({
      schemaVersion: 1,
      integration: { plugin: "github-com", sources: { boards: [99] } },
    });
    expect(fsMocks.readFileSync).toHaveBeenCalledWith(`${OVERRIDES_DIR}/my-project.yaml`, "utf-8");
  });

  it("throws IntegrationOverrideError with code YAML_PARSE on malformed YAML", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(":\n  - bad\n  unbalanced");
    try {
      mod.loadOverride("my-project");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(mod.IntegrationOverrideError);
      expect((e as InstanceType<typeof mod.IntegrationOverrideError>).code).toBe("YAML_PARSE");
    }
  });

  it("throws IntegrationOverrideError with code SCHEMA on schema mismatch", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue("schemaVersion: 1\nintegration: {}\nextra: true\n");
    try {
      mod.loadOverride("my-project");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(mod.IntegrationOverrideError);
      expect((e as InstanceType<typeof mod.IntegrationOverrideError>).code).toBe("SCHEMA");
    }
  });

  it("rejects path-traversal in projectId", () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(() => mod.loadOverride("../evil")).toThrowError(/Invalid projectId/);
  });
});

describe("saveOverride", () => {
  it("writes YAML atomically via tmp + rename", () => {
    mod.saveOverride("my-project", {
      schemaVersion: 1,
      integration: { plugin: "github-com", sources: { boards: [99] } },
    });
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(OVERRIDES_DIR, { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalled();
    const [tmpPath, contents] = fsMocks.writeFileSync.mock.calls[0];
    expect(tmpPath).toBe(`${OVERRIDES_DIR}/my-project.yaml.tmp`);
    expect(contents).toContain("schemaVersion: 1");
    expect(contents).toContain("plugin: github-com");
    expect(fsMocks.renameSync).toHaveBeenCalledWith(
      `${OVERRIDES_DIR}/my-project.yaml.tmp`,
      `${OVERRIDES_DIR}/my-project.yaml`,
    );
  });

  it("refuses to save an invalid envelope (wrong schemaVersion)", () => {
    expect(() =>
      mod.saveOverride("my-project", {
        // @ts-expect-error testing runtime rejection of wrong literal
        schemaVersion: 2,
        integration: {},
      }),
    ).toThrowError(/Refusing to save/);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects path-traversal in projectId", () => {
    expect(() => mod.saveOverride("../evil", { schemaVersion: 1, integration: {} })).toThrowError(
      /Invalid projectId/,
    );
  });
});

describe("getEffectiveIntegrationConfig", () => {
  it("TC-026: merges committed plugin/instance with override sources", () => {
    const effective = mod.getEffectiveIntegrationConfig(
      { plugin: "jira-self-hosted", instance: "https://jira.acme.com" },
      { schemaVersion: 1, integration: { sources: { boards: [12] } } },
    );
    expect(effective).toEqual({
      plugin: "jira-self-hosted",
      instance: "https://jira.acme.com",
      sources: { boards: [12] },
    });
  });

  it("TC-027: arrays REPLACE rather than concat", () => {
    const effective = mod.getEffectiveIntegrationConfig(
      { sources: { boards: [12, 34] } },
      { schemaVersion: 1, integration: { sources: { boards: [99] } } },
    );
    expect(effective.sources?.boards).toEqual([99]);
  });

  it("TC-065: empty array in override REPLACES non-empty committed array", () => {
    const effective = mod.getEffectiveIntegrationConfig(
      { sources: { boards: [12] } },
      { schemaVersion: 1, integration: { sources: { boards: [] } } },
    );
    expect(effective.sources?.boards).toEqual([]);
  });

  it("returns the committed config when no override exists", () => {
    const committed = { plugin: "github-com", sources: { repos: ["a/b"] } };
    expect(mod.getEffectiveIntegrationConfig(committed, null)).toEqual(committed);
  });

  it("returns the override integration when no committed config exists", () => {
    expect(
      mod.getEffectiveIntegrationConfig(undefined, {
        schemaVersion: 1,
        integration: { plugin: "github-com" },
      }),
    ).toEqual({ plugin: "github-com" });
  });

  it("returns an empty object when both sides are absent", () => {
    expect(mod.getEffectiveIntegrationConfig(undefined, null)).toEqual({});
  });
});
