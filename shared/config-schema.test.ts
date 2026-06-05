import { describe, it, expect } from "vitest";
import {
  RouboConfigSchema,
  ProjectConfigSchema,
  IntegrationOverrideSchema,
  SourceEntrySchema,
  zodIssuesToValidationErrors,
  zodIssuesToFieldMap,
  type RouboConfig,
} from "./config-schema.js";

function makeConfig(overrides?: Partial<RouboConfig>): RouboConfig {
  return {
    project: {
      name: "test-project",
      displayName: "Test Project",
      repo: "org/test-project",
    },
    layout: { type: "single-repo" },
    components: { backend: { type: "process", command: "dotnet run" } },
    ports: { backend: { base: 5000 } },
    benches: { max: 5 },
    ...overrides,
  };
}

describe("RouboConfigSchema: valid configs", () => {
  it("accepts a minimal valid config", () => {
    expect(RouboConfigSchema.safeParse(makeConfig()).success).toBe(true);
  });

  it("accepts a config with all optional fields", () => {
    const config = makeConfig({
      tools: [
        {
          type: "browser",
          name: "App",
          icon: "globe",
          url: "http://localhost:3000",
        },
      ],
      inspection: {
        framework: "jest",
        directory: "tests",
        command: "npm test",
      },
      jigs: { defaultJig: "my-jig" },
      users: [{ name: "Admin", properties: { email: "admin@example.com" } }],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });

  it("accepts a database component without command", () => {
    const config = makeConfig({ components: { db: { type: "database" } } });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });

  it("accepts multiple components and ports", () => {
    const config = makeConfig({
      components: {
        frontend: { type: "process", command: "npm start" },
        backend: { type: "process", command: "dotnet run" },
        db: {
          type: "database",
          docker: { composeFile: "docker-compose.yml", service: "db" },
        },
      },
      ports: { frontend: { base: 3000 }, backend: { base: 5000, https: true } },
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });
});

describe("RouboConfigSchema: required fields", () => {
  it("rejects missing project", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      project: undefined,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing layout", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      layout: undefined,
    });
    expect(result.success).toBe(false);
  });

  it("accepts missing components and defaults to {}", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      components: undefined,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.components).toEqual({});
  });

  it("accepts missing ports and defaults to {}", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      ports: undefined,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ports).toEqual({});
  });

  it("rejects missing benches", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      benches: undefined,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      unknownField: "value",
    });
    expect(result.success).toBe(false);
  });
});

describe("project.name", () => {
  it("accepts lowercase letters and numbers", () => {
    expect(
      ProjectConfigSchema.safeParse({
        ...makeConfig().project,
        name: "my-app-123",
      }).success,
    ).toBe(true);
  });

  it("rejects uppercase letters", () => {
    expect(ProjectConfigSchema.safeParse({ ...makeConfig().project, name: "MyApp" }).success).toBe(
      false,
    );
  });

  it("rejects spaces", () => {
    expect(ProjectConfigSchema.safeParse({ ...makeConfig().project, name: "my app" }).success).toBe(
      false,
    );
  });

  it("rejects underscores", () => {
    expect(ProjectConfigSchema.safeParse({ ...makeConfig().project, name: "my_app" }).success).toBe(
      false,
    );
  });

  it("error path is project.name", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      project: { ...makeConfig().project, name: "BAD" },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("project.name");
  });
});

describe("benches.max", () => {
  it("accepts 1", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ benches: { max: 1 } })).success).toBe(true);
  });

  it("accepts 99", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ benches: { max: 99 } })).success).toBe(true);
  });

  it("rejects 0", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ benches: { max: 0 } })).success).toBe(false);
  });

  it("rejects 100", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ benches: { max: 100 } })).success).toBe(false);
  });

  it("rejects non-integer", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ benches: { max: 1.5 } })).success).toBe(false);
  });
});

describe("ports.base", () => {
  it("accepts 1", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ ports: { web: { base: 1 } } })).success).toBe(
      true,
    );
  });

  it("accepts 65535", () => {
    expect(
      RouboConfigSchema.safeParse(makeConfig({ ports: { web: { base: 65535 } } })).success,
    ).toBe(true);
  });

  it("rejects 0", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ ports: { web: { base: 0 } } })).success).toBe(
      false,
    );
  });

  it("rejects 65536", () => {
    expect(
      RouboConfigSchema.safeParse(makeConfig({ ports: { web: { base: 65536 } } })).success,
    ).toBe(false);
  });
});

describe("components map", () => {
  it("accepts empty components", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ components: {} })).success).toBe(true);
  });

  it("accepts empty ports", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ ports: {} })).success).toBe(true);
  });

  it("rejects a process component without command", () => {
    const result = RouboConfigSchema.safeParse(
      makeConfig({ components: { api: { type: "process" } } }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.includes("command"))).toBe(true);
  });

  it("rejects a component with unknown keys", () => {
    const result = RouboConfigSchema.safeParse(
      makeConfig({
        components: {
          api: {
            type: "process",
            command: "npm start",
            comand: "oops",
          } as unknown as {
            type: "process";
            command: string;
          },
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("layout submodule reserved key", () => {
  it('rejects "." as a submodule key', () => {
    const config = makeConfig({
      layout: {
        type: "meta-repo",
        submodules: {
          ".": "git@github.com:org/root.git",
          "sub-a": "git@github.com:org/sub.git",
        },
      },
    });
    const result = RouboConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some((i) => i.message.includes('"."') && i.message.includes("reserved")),
    ).toBe(true);
  });

  it('accepts submodule keys starting with "." but not exactly "."', () => {
    const config = makeConfig({
      layout: {
        type: "meta-repo",
        submodules: {
          ".hidden": "git@github.com:org/h.git",
          "..": "git@github.com:org/dd.git",
        },
      },
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });
});

describe("tools", () => {
  it("rejects a shell tool with login", () => {
    const config = makeConfig({
      tools: [
        {
          type: "shell",
          name: "Shell",
          icon: "terminal",
          command: "bash",
          login: { steps: [{ selector: "input", action: "click" }] },
        } as unknown as ReturnType<typeof makeConfig>["tools"][0],
      ],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(false);
  });

  it("accepts a browser tool with login", () => {
    const config = makeConfig({
      tools: [
        {
          type: "browser",
          name: "App",
          icon: "globe",
          url: "http://localhost",
          login: {
            steps: [{ selector: "input", action: "fill", value: "{{user.email}}" }],
          },
        },
      ],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects a fill step without a value", () => {
    const config = makeConfig({
      tools: [
        {
          type: "browser",
          name: "App",
          icon: "globe",
          login: {
            steps: [{ selector: "input[name=email]", action: "fill" as const }],
          },
        },
      ],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects a fill step with an empty value", () => {
    const config = makeConfig({
      tools: [
        {
          type: "browser",
          name: "App",
          icon: "globe",
          login: {
            steps: [{ selector: "input", action: "fill" as const, value: "" }],
          },
        },
      ],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(false);
  });

  it("accepts a click step without value", () => {
    const config = makeConfig({
      tools: [
        {
          type: "browser",
          name: "App",
          icon: "globe",
          login: { steps: [{ selector: "button", action: "click" as const }] },
        },
      ],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects login with empty steps array", () => {
    const config = makeConfig({
      tools: [
        {
          type: "browser",
          name: "App",
          icon: "globe",
          login: { steps: [] } as unknown as {
            steps: [{ selector: string; action: "click" }];
          },
        },
      ],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects a step with extra fields", () => {
    const config = makeConfig({
      tools: [
        {
          type: "browser",
          name: "App",
          icon: "globe",
          login: {
            steps: [
              {
                selector: "input",
                action: "click" as const,
                extra: "field",
              } as unknown as { selector: string; action: "click" },
            ],
          },
        },
      ],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("users", () => {
  it("accepts a config with users", () => {
    const config = makeConfig({
      users: [{ name: "Admin", properties: { email: "admin@example.com" } }],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });

  it("accepts empty users array", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ users: [] })).success).toBe(true);
  });

  it("rejects duplicate users", () => {
    const user = { name: "Alice", properties: { email: "alice@example.com" } };
    expect(RouboConfigSchema.safeParse(makeConfig({ users: [user, user] })).success).toBe(false);
  });

  it("rejects duplicate users even when property key order differs", () => {
    const u1 = { name: "Alice", properties: { a: "1", b: "2" } };
    const u2 = { name: "Alice", properties: { b: "2", a: "1" } };
    expect(RouboConfigSchema.safeParse(makeConfig({ users: [u1, u2] })).success).toBe(false);
  });

  it("allows users with same name but different properties", () => {
    const u1 = { name: "Alice", properties: { role: "admin" } };
    const u2 = { name: "Alice", properties: { role: "viewer" } };
    expect(RouboConfigSchema.safeParse(makeConfig({ users: [u1, u2] })).success).toBe(true);
  });

  it("rejects a user with empty name", () => {
    const config = makeConfig({
      users: [{ name: "", properties: { email: "a@b.com" } }],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(false);
  });

  it("rejects a user with extra fields", () => {
    const config = makeConfig({
      users: [
        { name: "Test", properties: {}, extra: "field" } as unknown as {
          name: string;
          properties: Record<string, string>;
        },
      ],
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("integration block", () => {
  it("accepts a config without an integration block (backward compatibility)", () => {
    expect(RouboConfigSchema.safeParse(makeConfig()).success).toBe(true);
  });

  it("accepts an empty integration block (all fields optional)", () => {
    expect(RouboConfigSchema.safeParse(makeConfig({ integration: {} })).success).toBe(true);
  });

  it("accepts an integration block with only plugin", () => {
    const config = makeConfig({ integration: { plugin: "github-com" } });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });

  it("accepts an integration block with plugin, instance, sources, and pluginSource", () => {
    const config = makeConfig({
      integration: {
        plugin: "jira-self-hosted",
        instance: "https://jira.acme.com",
        sources: { boards: [12], repos: ["owner/repo"] },
        pluginSource: "git@github.com:acme/roubo-jira-plugin.git",
      },
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });

  it("accepts numeric-only and string-only source arrays", () => {
    const config = makeConfig({
      integration: { sources: { boards: [12, 34], repos: ["a/b", "c/d"] } },
    });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects unknown fields inside the integration block", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      integration: { plugin: "jira-self-hosted", bogus_field: true },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths.some((p) => p.includes("bogus_field") || p.startsWith("integration"))).toBe(true);
  });

  it("rejects a non-array value inside sources", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      integration: { sources: { boards: "not-an-array" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("SourceEntrySchema per-source alert booleans (FR-074, TC-135)", () => {
  it("accepts an object entry with all three booleans set to true", () => {
    const result = SourceEntrySchema.safeParse({
      externalId: "owner/repo",
      includeCodeQLAlerts: true,
      includeSecretScanningAlerts: true,
      includeDependabotAlerts: true,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an object entry with all three booleans set to false", () => {
    const result = SourceEntrySchema.safeParse({
      externalId: "owner/repo",
      includeCodeQLAlerts: false,
      includeSecretScanningAlerts: false,
      includeDependabotAlerts: false,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an object entry omitting all three booleans (all optional)", () => {
    const result = SourceEntrySchema.safeParse({ externalId: "owner/repo" });
    expect(result.success).toBe(true);
  });

  it("accepts an object entry with only one boolean set", () => {
    const result = SourceEntrySchema.safeParse({
      externalId: "owner/repo",
      includeDependabotAlerts: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-boolean includeCodeQLAlerts", () => {
    const result = SourceEntrySchema.safeParse({
      externalId: "owner/repo",
      includeCodeQLAlerts: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean includeSecretScanningAlerts", () => {
    const result = SourceEntrySchema.safeParse({
      externalId: "owner/repo",
      includeSecretScanningAlerts: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean includeDependabotAlerts", () => {
    const result = SourceEntrySchema.safeParse({
      externalId: "owner/repo",
      includeDependabotAlerts: null,
    });
    expect(result.success).toBe(false);
  });

  it("preserves the booleans alongside excludedStatuses on a single entry", () => {
    const entry = {
      externalId: "owner/repo",
      excludedStatuses: ["Closed"],
      includeCodeQLAlerts: true,
      includeSecretScanningAlerts: false,
      includeDependabotAlerts: true,
    };
    const result = SourceEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual(entry);
  });

  it("round-trips through RouboConfigSchema on integration.sources entries", () => {
    const config = makeConfig({
      integration: {
        sources: {
          repo: [
            {
              externalId: "owner/repo",
              includeCodeQLAlerts: true,
              includeSecretScanningAlerts: false,
              includeDependabotAlerts: true,
            },
          ],
        },
      },
    });
    const parsed = RouboConfigSchema.safeParse(config);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const reparsed = RouboConfigSchema.safeParse(parsed.data);
    expect(reparsed.success).toBe(true);
    if (!reparsed.success) return;
    expect(reparsed.data.integration?.sources?.repo?.[0]).toEqual({
      externalId: "owner/repo",
      includeCodeQLAlerts: true,
      includeSecretScanningAlerts: false,
      includeDependabotAlerts: true,
    });
  });
});

describe("SourceEntrySchema project-scoped Jira fields (FR-012, TC-012)", () => {
  it("accepts an object entry with project, boardMode, and mineScope", () => {
    const result = SourceEntrySchema.safeParse({
      externalId: "board:482",
      project: "PLAT",
      boardMode: "active-sprint",
    });
    expect(result.success).toBe(true);
  });

  it("accepts the synthetic mine sentinel entry", () => {
    const entry = { externalId: "mine", mineScope: "in-project", project: "PLAT" };
    const result = SourceEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual(entry);
  });

  it("accepts an anywhere-scoped mine entry without a project", () => {
    const result = SourceEntrySchema.safeParse({ externalId: "mine", mineScope: "anywhere" });
    expect(result.success).toBe(true);
  });

  it("still accepts the bare string and number primitive forms", () => {
    expect(SourceEntrySchema.safeParse("PLAT").success).toBe(true);
    expect(SourceEntrySchema.safeParse(482).success).toBe(true);
  });

  it("rejects an invalid boardMode enum value", () => {
    const result = SourceEntrySchema.safeParse({
      externalId: "board:482",
      boardMode: "whole-sprint",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid mineScope enum value", () => {
    const result = SourceEntrySchema.safeParse({ externalId: "mine", mineScope: "everywhere" });
    expect(result.success).toBe(false);
  });

  it("parses a mixed-type sources block with project scope preserved per source", () => {
    const config = makeConfig({
      integration: {
        plugin: "jira-self-hosted",
        instance: "https://jira.acme.com",
        excludedStatusCategories: ["Done"],
        sources: {
          project: [{ externalId: "PLAT", project: "PLAT" }],
          board: [{ externalId: "board:482", project: "PLAT", boardMode: "active-sprint" }],
          filter: [{ externalId: "10231", project: "PLAT" }],
          epic: [{ externalId: "PLAT-1187", project: "PLAT" }],
          mine: [{ externalId: "mine", mineScope: "in-project", project: "PLAT" }],
        },
      },
    });
    const parsed = RouboConfigSchema.safeParse(config);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.integration?.sources?.board?.[0]).toEqual({
      externalId: "board:482",
      project: "PLAT",
      boardMode: "active-sprint",
    });
    expect(parsed.data.integration?.excludedStatusCategories).toEqual(["Done"]);
  });
});

describe("IntegrationConfigSchema excludedStatusCategories (FR-010)", () => {
  it("accepts a root excludedStatusCategories list", () => {
    const config = makeConfig({ integration: { excludedStatusCategories: ["Done"] } });
    expect(RouboConfigSchema.safeParse(config).success).toBe(true);
  });

  it("rejects an empty-string status category", () => {
    const config = makeConfig({ integration: { excludedStatusCategories: [""] } });
    expect(RouboConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("IntegrationOverrideSchema", () => {
  it("accepts a minimal envelope with an empty integration block", () => {
    expect(IntegrationOverrideSchema.safeParse({ schemaVersion: 1, integration: {} }).success).toBe(
      true,
    );
  });

  it("accepts a full integration override", () => {
    const result = IntegrationOverrideSchema.safeParse({
      schemaVersion: 1,
      integration: {
        plugin: "jira-self-hosted",
        instance: "https://jira.acme.com",
        sources: { boards: [12], repos: ["owner/repo"] },
      },
    });
    expect(result.success).toBe(true);
  });

  it("round-trips a per-user override carrying project-scoped mixed-type sources (TC-012)", () => {
    const result = IntegrationOverrideSchema.safeParse({
      schemaVersion: 1,
      integration: {
        excludedStatusCategories: ["Done"],
        sources: {
          board: [{ externalId: "board:482", project: "PLAT", boardMode: "active-sprint" }],
          mine: [{ externalId: "mine", mineScope: "in-project", project: "PLAT" }],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.integration.sources?.board?.[0]).toEqual({
      externalId: "board:482",
      project: "PLAT",
      boardMode: "active-sprint",
    });
  });

  it("rejects a missing schemaVersion", () => {
    expect(IntegrationOverrideSchema.safeParse({ integration: {} }).success).toBe(false);
  });

  it("rejects a non-1 schemaVersion", () => {
    expect(IntegrationOverrideSchema.safeParse({ schemaVersion: 2, integration: {} }).success).toBe(
      false,
    );
  });

  it("rejects unknown top-level keys (strict envelope)", () => {
    expect(
      IntegrationOverrideSchema.safeParse({
        schemaVersion: 1,
        integration: {},
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys inside integration (strict)", () => {
    expect(
      IntegrationOverrideSchema.safeParse({
        schemaVersion: 1,
        integration: { bogus: 1 },
      }).success,
    ).toBe(false);
  });
});

describe("zodIssuesToValidationErrors", () => {
  it("converts issues to path/message pairs", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      project: { ...makeConfig().project, name: "BAD NAME" },
    });
    if (result.success) throw new Error("expected failure");
    const errors = zodIssuesToValidationErrors(result.error.issues);
    expect(errors.some((e) => e.path === "project.name")).toBe(true);
    expect(errors.every((e) => typeof e.path === "string" && typeof e.message === "string")).toBe(
      true,
    );
  });
});

describe("zodIssuesToFieldMap", () => {
  it("produces dotted keys from issue paths", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      project: { ...makeConfig().project, name: "BAD" },
      benches: { max: 200 },
    });
    if (result.success) throw new Error("expected failure");
    const map = zodIssuesToFieldMap(result.error.issues);
    expect(map["project.name"]).toBeDefined();
    expect(map["benches.max"]).toBeDefined();
  });

  it("first issue wins for duplicate paths", () => {
    const result = RouboConfigSchema.safeParse({
      ...makeConfig(),
      project: { ...makeConfig().project, name: "BAD" },
    });
    if (result.success) throw new Error("expected failure");
    const map = zodIssuesToFieldMap(result.error.issues);
    expect(typeof map["project.name"]).toBe("string");
  });

  it("skips issues with empty path", () => {
    // An unrecognized top-level key trips `.strict()`, which reports at the
    // object root (empty path); zodIssuesToFieldMap should drop it.
    const result = RouboConfigSchema.safeParse({ ...makeConfig(), unknownKey: true });
    if (result.success) throw new Error("expected failure");
    const map = zodIssuesToFieldMap(result.error.issues);
    expect("" in map).toBe(false);
  });
});
