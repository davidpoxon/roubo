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
      null,
      { schemaVersion: 1, integration: { sources: { boards: [12] } } },
    );
    expect(effective).toEqual({
      plugin: "jira-self-hosted",
      instance: "https://jira.acme.com",
      sources: { boards: [12] },
    });
  });

  it("TC-027: arrays REPLACE rather than concat", () => {
    const effective = mod.getEffectiveIntegrationConfig({ sources: { boards: [12, 34] } }, null, {
      schemaVersion: 1,
      integration: { sources: { boards: [99] } },
    });
    expect(effective.sources?.boards).toEqual([99]);
  });

  it("TC-065: empty array in override REPLACES non-empty committed array", () => {
    const effective = mod.getEffectiveIntegrationConfig({ sources: { boards: [12] } }, null, {
      schemaVersion: 1,
      integration: { sources: { boards: [] } },
    });
    expect(effective.sources?.boards).toEqual([]);
  });

  it("returns the committed config when no override exists", () => {
    const committed = { plugin: "github-com", sources: { repos: ["a/b"] } };
    expect(mod.getEffectiveIntegrationConfig(committed, null, null)).toEqual(committed);
  });

  it("returns the override integration when no committed config exists", () => {
    expect(
      mod.getEffectiveIntegrationConfig(undefined, null, {
        schemaVersion: 1,
        integration: { plugin: "github-com" },
      }),
    ).toEqual({ plugin: "github-com" });
  });

  it("returns an empty object when all sides are absent", () => {
    expect(mod.getEffectiveIntegrationConfig(undefined, null, null)).toEqual({});
  });

  it("layers committed ⊕ global ⊕ project: project beats global beats committed", () => {
    const effective = mod.getEffectiveIntegrationConfig(
      { plugin: "github-com", instance: "from-committed", pageSize: 10 },
      {
        schemaVersion: 1,
        integration: { instance: "from-global", advanced: { token: "global" } },
      },
      { schemaVersion: 1, integration: { instance: "from-project" } },
    );
    expect(effective).toEqual({
      plugin: "github-com",
      instance: "from-project",
      pageSize: 10,
      advanced: { token: "global" },
    });
  });

  it("applies a global override when no per-project override exists", () => {
    const effective = mod.getEffectiveIntegrationConfig(
      undefined,
      {
        schemaVersion: 1,
        integration: { plugin: "github-com", instance: "from-global" },
      },
      null,
    );
    expect(effective).toEqual({ plugin: "github-com", instance: "from-global" });
  });

  it("issue #125: strips a stale `advanced.sources` shadow merged in from the global layer", () => {
    // Mirrors a real ~/.roubo/integrations/_global/github-com.yaml that still
    // carries the pre-fix `advanced.sources: ""` leftover. Left in place it
    // rides into the Configure dialog seed and the Verify snapshot, where the
    // GitHub-family plugins reject it ("sources must be an array").
    const effective = mod.getEffectiveIntegrationConfig(
      undefined,
      {
        schemaVersion: 1,
        integration: {
          plugin: "github-com",
          advanced: { sources: "", token: "global" },
        },
      },
      null,
    );
    expect(effective).toEqual({
      plugin: "github-com",
      advanced: { token: "global" },
    });
  });

  it("issue #125: drops the `advanced` key entirely when its only key was a shadow", () => {
    const effective = mod.getEffectiveIntegrationConfig(
      undefined,
      {
        schemaVersion: 1,
        integration: { plugin: "github-com", advanced: { sources: "" } },
      },
      null,
    );
    expect(effective).toEqual({ plugin: "github-com" });
    expect(effective.advanced).toBeUndefined();
  });
});

const GLOBAL_DIR = `${OVERRIDES_DIR}/_global`;

describe("loadGlobalOverride", () => {
  it("returns null when no per-plugin global file exists", () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(mod.loadGlobalOverride("github-com")).toBeNull();
  });

  it("returns the parsed envelope when the file is valid", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue(
      "schemaVersion: 1\nintegration:\n  plugin: github-com\n  instance: from-global\n",
    );
    expect(mod.loadGlobalOverride("github-com")).toEqual({
      schemaVersion: 1,
      integration: { plugin: "github-com", instance: "from-global" },
    });
    expect(fsMocks.readFileSync).toHaveBeenCalledWith(`${GLOBAL_DIR}/github-com.yaml`, "utf-8");
  });

  it("throws IntegrationOverrideError with code SCHEMA on schema mismatch", () => {
    fsMocks.existsSync.mockReturnValue(true);
    fsMocks.readFileSync.mockReturnValue("schemaVersion: 1\nintegration: {}\nextra: true\n");
    try {
      mod.loadGlobalOverride("github-com");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(mod.IntegrationOverrideError);
      expect((e as InstanceType<typeof mod.IntegrationOverrideError>).code).toBe("SCHEMA");
    }
  });

  it("rejects path-traversal in pluginId", () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(() => mod.loadGlobalOverride("../evil")).toThrowError(/Invalid pluginId/);
  });
});

describe("saveGlobalOverride", () => {
  it("writes per-plugin YAML to ~/.roubo/integrations/_global/{pluginId}.yaml atomically", () => {
    mod.saveGlobalOverride("github-com", {
      schemaVersion: 1,
      integration: { plugin: "github-com", instance: "from-global" },
    });
    expect(fsMocks.mkdirSync).toHaveBeenCalledWith(GLOBAL_DIR, { recursive: true });
    expect(fsMocks.writeFileSync).toHaveBeenCalled();
    const [tmpPath, contents] = fsMocks.writeFileSync.mock.calls[0];
    expect(tmpPath).toBe(`${GLOBAL_DIR}/github-com.yaml.tmp`);
    expect(contents).toContain("schemaVersion: 1");
    expect(contents).toContain("plugin: github-com");
    expect(fsMocks.renameSync).toHaveBeenCalledWith(
      `${GLOBAL_DIR}/github-com.yaml.tmp`,
      `${GLOBAL_DIR}/github-com.yaml`,
    );
  });

  it("refuses to save an invalid envelope", () => {
    expect(() =>
      mod.saveGlobalOverride("github-com", {
        // @ts-expect-error testing runtime rejection of wrong literal
        schemaVersion: 2,
        integration: {},
      }),
    ).toThrowError(/Refusing to save/);
    expect(fsMocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects path-traversal in pluginId", () => {
    expect(() =>
      mod.saveGlobalOverride("../evil", { schemaVersion: 1, integration: {} }),
    ).toThrowError(/Invalid pluginId/);
  });
});

describe("getEffectiveWithGlobal", () => {
  it("layers per-plugin global when project override resolves a plugin id", () => {
    fsMocks.existsSync.mockImplementation((p: string) => p === `${GLOBAL_DIR}/github-com.yaml`);
    fsMocks.readFileSync.mockReturnValue(
      "schemaVersion: 1\nintegration:\n  instance: from-global\n",
    );

    const effective = mod.getEffectiveWithGlobal(undefined, {
      schemaVersion: 1,
      integration: { plugin: "github-com" },
    });
    expect(effective).toEqual({ plugin: "github-com", instance: "from-global" });
  });

  it("project override wins over global override on conflicting fields", () => {
    fsMocks.existsSync.mockImplementation((p: string) => p === `${GLOBAL_DIR}/github-com.yaml`);
    fsMocks.readFileSync.mockReturnValue(
      "schemaVersion: 1\nintegration:\n  instance: from-global\n",
    );

    const effective = mod.getEffectiveWithGlobal(undefined, {
      schemaVersion: 1,
      integration: { plugin: "github-com", instance: "from-project" },
    });
    expect(effective.instance).toBe("from-project");
  });

  it("swallows a malformed global file rather than crashing the project read", () => {
    fsMocks.existsSync.mockImplementation((p: string) => p === `${GLOBAL_DIR}/github-com.yaml`);
    fsMocks.readFileSync.mockReturnValue("schemaVersion: 1\nintegration: {}\nextra: true\n");

    const effective = mod.getEffectiveWithGlobal(
      { plugin: "github-com", instance: "from-committed" },
      null,
    );
    expect(effective).toEqual({ plugin: "github-com", instance: "from-committed" });
  });

  it("returns committed ⊕ project when no plugin id resolves", () => {
    fsMocks.existsSync.mockReturnValue(false);
    expect(
      mod.getEffectiveWithGlobal(
        { instance: "from-committed" },
        {
          schemaVersion: 1,
          integration: { advanced: { token: "p" } },
        },
      ),
    ).toEqual({ instance: "from-committed", advanced: { token: "p" } });
  });

  it("issue #125: strips a stale `advanced.sources` from a real-shaped global file", () => {
    // The actual ~/.roubo/integrations/_global/github-com.yaml that broke
    // Verify/Save for ai-agent-marketplace.
    fsMocks.existsSync.mockImplementation((p: string) => p === `${GLOBAL_DIR}/github-com.yaml`);
    fsMocks.readFileSync.mockReturnValue(
      [
        "schemaVersion: 1",
        "integration:",
        "  plugin: github-com",
        "  advanced:",
        '    sources: ""',
        "  capturedUserId:",
        "    externalId: davidpoxon",
        "    displayName: David Poxon",
        "",
      ].join("\n"),
    );

    const effective = mod.getEffectiveWithGlobal(undefined, {
      schemaVersion: 1,
      integration: { plugin: "github-com" },
    });

    expect(effective.advanced).toBeUndefined();
    expect(effective).toEqual({
      plugin: "github-com",
      capturedUserId: { externalId: "davidpoxon", displayName: "David Poxon" },
    });
  });
});

const GH_DEFAULTS = ["Closed", "Done", "Resolved", "In review", "PR open", "Waiting on reviewer"];

describe("excludedStatuses three-layer merge (FR-062, FR-063)", () => {
  it("TC-122: per-source override beats per-project beats plugin-global", () => {
    const projectLevel: import("@roubo/shared").IntegrationOverride = {
      schemaVersion: 1,
      integration: {
        excludedStatuses: ["Closed"],
        sources: {
          repos: [{ externalId: "repo-a", excludedStatuses: ["Closed", "Blocked"] }],
        },
      },
    };
    const effective = mod.getEffectiveIntegrationConfig(undefined, null, projectLevel);
    const applied = mod.applyPerSourceExcludedStatuses(effective, GH_DEFAULTS);

    expect(mod.sourceExcludedStatuses(applied, "repo-a", GH_DEFAULTS)).toEqual([
      "Closed",
      "Blocked",
    ]);
  });

  it("per-project root override beats plugin-global default for sources with no per-source value", () => {
    const projectLevel: import("@roubo/shared").IntegrationOverride = {
      schemaVersion: 1,
      integration: {
        excludedStatuses: ["Closed"],
        sources: { repos: ["repo-a"] },
      },
    };
    const effective = mod.getEffectiveIntegrationConfig(undefined, null, projectLevel);
    const applied = mod.applyPerSourceExcludedStatuses(effective, GH_DEFAULTS);

    expect(mod.sourceExcludedStatuses(applied, "repo-a", GH_DEFAULTS)).toEqual(["Closed"]);
  });

  it("plugin-global default applies when no per-project root and no per-source override exists", () => {
    const projectLevel: import("@roubo/shared").IntegrationOverride = {
      schemaVersion: 1,
      integration: { sources: { repos: ["repo-a"] } },
    };
    const effective = mod.getEffectiveIntegrationConfig(undefined, null, projectLevel);
    const applied = mod.applyPerSourceExcludedStatuses(effective, GH_DEFAULTS);

    expect(mod.sourceExcludedStatuses(applied, "repo-a", GH_DEFAULTS)).toEqual(GH_DEFAULTS);
  });

  it("returns undefined when no layer has an opinion", () => {
    const applied = mod.applyPerSourceExcludedStatuses(
      { sources: { repos: ["repo-a"] } },
      undefined,
    );
    expect(mod.sourceExcludedStatuses(applied, "repo-a", undefined)).toBeUndefined();
    // Primitive entries stay primitive when no fallback applies.
    expect(applied.sources?.repos[0]).toBe("repo-a");
  });

  it("TC-123: post-merge pass walks every source entry and is idempotent", () => {
    const projectLevel: import("@roubo/shared").IntegrationOverride = {
      schemaVersion: 1,
      integration: {
        excludedStatuses: ["Closed"],
        sources: {
          repos: [
            { externalId: "repo-a", excludedStatuses: ["Closed", "Blocked"] },
            { externalId: "repo-b", excludedStatuses: ["Closed", "Deferred"] },
          ],
        },
      },
    };
    const effective = mod.getEffectiveIntegrationConfig(undefined, null, projectLevel);
    const once = mod.applyPerSourceExcludedStatuses(effective, GH_DEFAULTS);
    const twice = mod.applyPerSourceExcludedStatuses(once, GH_DEFAULTS);

    expect(mod.sourceExcludedStatuses(once, "repo-a", GH_DEFAULTS)).toEqual(["Closed", "Blocked"]);
    expect(mod.sourceExcludedStatuses(once, "repo-b", GH_DEFAULTS)).toEqual(["Closed", "Deferred"]);
    expect(twice).toEqual(once);
  });

  it("post-merge pass is idempotent on a mixed-shape sources structure", () => {
    const projectLevel: import("@roubo/shared").IntegrationOverride = {
      schemaVersion: 1,
      integration: {
        excludedStatuses: ["Closed"],
        sources: {
          repos: ["repo-a", { externalId: "repo-b", excludedStatuses: ["Closed", "Blocked"] }],
        },
      },
    };
    const effective = mod.getEffectiveIntegrationConfig(undefined, null, projectLevel);
    const once = mod.applyPerSourceExcludedStatuses(effective, GH_DEFAULTS);
    const twice = mod.applyPerSourceExcludedStatuses(once, GH_DEFAULTS);

    // Primitive entry got normalised to object form with the root fallback.
    expect(once.sources?.repos).toEqual([
      { externalId: "repo-a", excludedStatuses: ["Closed"] },
      { externalId: "repo-b", excludedStatuses: ["Closed", "Blocked"] },
    ]);
    expect(twice).toEqual(once);
  });

  it("root-level excludedStatuses follows array-replace merge semantics across layers", () => {
    const effective = mod.getEffectiveIntegrationConfig(
      { excludedStatuses: ["Closed", "Done"] },
      { schemaVersion: 1, integration: { excludedStatuses: ["Done"] } },
      { schemaVersion: 1, integration: { excludedStatuses: ["Blocked"] } },
    );
    expect(effective.excludedStatuses).toEqual(["Blocked"]);
  });

  it("returns input unchanged when sources is absent", () => {
    const input: import("@roubo/shared").IntegrationConfig = {
      plugin: "github-com",
      excludedStatuses: ["Closed"],
    };
    expect(mod.applyPerSourceExcludedStatuses(input, GH_DEFAULTS)).toBe(input);
  });
});
