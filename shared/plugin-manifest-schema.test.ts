import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  PluginManifestSchema,
  PluginDefaultIntegrationConfigSchema,
  type PluginManifest,
} from "./plugin-manifest-schema.js";
import { RouboConfigSchema, zodIssuesToValidationErrors } from "./config-schema.js";

function makeManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    id: "github-com",
    name: "GitHub.com",
    version: "1.0.0",
    description: "GitHub.com integration plugin",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "./dist/index.js",
    permissions: {
      network: { hosts: ["api.github.com"] },
      credentials: {
        slots: [
          {
            slot: "github-oauth-token",
            scope: "read-write",
            description: "OAuth token for GitHub.com API access",
          },
        ],
      },
      filesystem: { paths: [] },
      processes: false,
    },
    ...overrides,
  };
}

function expectFieldError(
  result: ReturnType<typeof PluginManifestSchema.safeParse>,
  expectedPath: string,
): void {
  expect(result.success).toBe(false);
  if (result.success) return;
  const errors = zodIssuesToValidationErrors(result.error.issues);
  const match = errors.find((e) => e.path === expectedPath);
  if (!match) {
    throw new Error(`expected an error at path "${expectedPath}", got: ${JSON.stringify(errors)}`);
  }
  expect(match.message.length).toBeGreaterThan(0);
}

function omitField<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const { [key]: _omitted, ...rest } = obj;
  void _omitted;
  return rest;
}

describe("PluginManifestSchema: TC-006 happy paths", () => {
  it("accepts a manifest with all four permission categories populated", () => {
    const manifest = makeManifest({
      permissions: {
        network: { hosts: ["api.github.com", "*.githubusercontent.com"] },
        credentials: {
          slots: [
            { slot: "github-oauth-token", scope: "read-write", description: "OAuth token" },
            { slot: "github-pat", scope: "read", description: "Personal access token" },
          ],
        },
        filesystem: { paths: ["~/.config/gh"] },
        processes: { executables: ["git"] },
      },
    });
    const result = PluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions.network.hosts).toHaveLength(2);
      expect(result.data.permissions.credentials.slots).toHaveLength(2);
      expect(result.data.permissions.filesystem.paths).toEqual(["~/.config/gh"]);
      expect(result.data.permissions.processes).toEqual({ executables: ["git"] });
    }
  });

  it("accepts a manifest with all four permission categories empty", () => {
    const manifest = makeManifest({
      permissions: {
        network: { hosts: [] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
      },
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("accepts a manifest with all optional fields populated", () => {
    const manifest = makeManifest({
      configSchema: {
        type: "object",
        properties: { instance: { type: "string" } },
      },
      capabilities: {},
      icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>',
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("accepts a manifest with a relative-path icon", () => {
    const manifest = makeManifest({ icon: "assets/icon.svg" });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("accepts the tracker-action capability flags (#705)", () => {
    const manifest = makeManifest({
      capabilities: { supportsCreateIssue: true, supportsBlockingLinks: false },
    });
    const result = PluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual({
        supportsCreateIssue: true,
        supportsBlockingLinks: false,
      });
    }
  });

  it("rejects an unknown key on capabilities (strict)", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({ capabilities: { supportsTimeTravel: true } as never }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an empty icon string", () => {
    const result = PluginManifestSchema.safeParse(makeManifest({ icon: "" }));
    expectFieldError(result, "icon");
  });

  it("rejects an icon exceeding the 16 KB ceiling", () => {
    const huge = "a".repeat(16 * 1024 + 1);
    const result = PluginManifestSchema.safeParse(makeManifest({ icon: huge }));
    expectFieldError(result, "icon");
  });
});

describe("PluginManifestSchema: missing required top-level fields", () => {
  const requiredTopLevelFields: Array<keyof PluginManifest> = [
    "id",
    "name",
    "version",
    "description",
    "kind",
    "roubo",
    "entry",
    "permissions",
  ];

  for (const field of requiredTopLevelFields) {
    it(`rejects manifest missing ${field}`, () => {
      const manifest = omitField(makeManifest(), field);
      expectFieldError(PluginManifestSchema.safeParse(manifest), field);
    });
  }
});

describe("PluginManifestSchema: missing required permission categories", () => {
  const categories = ["network", "credentials", "filesystem", "processes"] as const;

  for (const category of categories) {
    it(`rejects manifest missing permissions.${category}`, () => {
      const base = makeManifest();
      const manifest = { ...base, permissions: omitField(base.permissions, category) };
      expectFieldError(PluginManifestSchema.safeParse(manifest), `permissions.${category}`);
    });
  }
});

describe("PluginManifestSchema: strict top-level", () => {
  it("rejects unknown top-level fields", () => {
    const manifest = { ...makeManifest(), unexpectedField: "nope" } as unknown as PluginManifest;
    const result = PluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (result.success) return;
    const hasUnrecognized = result.error.issues.some((issue) => issue.code === "unrecognized_keys");
    expect(hasUnrecognized).toBe(true);
  });
});

describe("PluginManifestSchema: value validation", () => {
  it("rejects non-kebab-case id", () => {
    const result = PluginManifestSchema.safeParse(makeManifest({ id: "GitHub_Com" }));
    expectFieldError(result, "id");
  });

  it("rejects empty id", () => {
    const result = PluginManifestSchema.safeParse(makeManifest({ id: "" }));
    expectFieldError(result, "id");
  });

  it('rejects kind other than "integration"', () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({ kind: "ai-agent" as unknown as "integration" }),
    );
    expectFieldError(result, "kind");
  });

  it("rejects credential slot with invalid scope", () => {
    const manifest = makeManifest({
      permissions: {
        network: { hosts: [] },
        credentials: {
          slots: [
            {
              slot: "token",
              scope: "write" as unknown as "read" | "read-write",
              description: "x",
            },
          ],
        },
        filesystem: { paths: [] },
        processes: false,
      },
    });
    expectFieldError(
      PluginManifestSchema.safeParse(manifest),
      "permissions.credentials.slots.0.scope",
    );
  });

  it("rejects credential slot missing description", () => {
    const manifest = makeManifest({
      permissions: {
        network: { hosts: [] },
        credentials: {
          slots: [
            { slot: "token", scope: "read" } as unknown as {
              slot: string;
              scope: "read" | "read-write";
              description: string;
            },
          ],
        },
        filesystem: { paths: [] },
        processes: false,
      },
    });
    expectFieldError(
      PluginManifestSchema.safeParse(manifest),
      "permissions.credentials.slots.0.description",
    );
  });

  it("rejects processes value that is neither false nor an executables object", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        permissions: {
          network: { hosts: [] },
          credentials: { slots: [] },
          filesystem: { paths: [] },
          processes: true as unknown as false,
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects processes object with unknown key", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        permissions: {
          network: { hosts: [] },
          credentials: { slots: [] },
          filesystem: { paths: [] },
          processes: { executables: ["git"], extra: true } as unknown as {
            executables: string[];
          },
        },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("PluginManifestSchema: component kind (FR-001)", () => {
  it("accepts a manifest with kind: component", () => {
    const manifest = makeManifest({ kind: "component", contractVersion: 1 });
    const result = PluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("component");
    }
  });

  it("still accepts a manifest with kind: integration unchanged", () => {
    const result = PluginManifestSchema.safeParse(makeManifest({ kind: "integration" }));
    expect(result.success).toBe(true);
  });

  it("rejects an unknown kind with a clear error", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({ kind: "ai-agent" as unknown as "integration" }),
    );
    expectFieldError(result, "kind");
  });

  it("discovers a kind: component manifest through parseManifest", async () => {
    const { parseManifest } = await import("./plugin-manifest.js");
    const yaml = [
      "id: db-postgres",
      "name: Postgres database",
      "version: 1.0.0",
      "description: First-party database component plugin",
      "kind: component",
      "roubo: ^1.3.0",
      "entry: ./dist/index.js",
      "contractVersion: 1",
      "permissions:",
      "  network: { hosts: [] }",
      "  credentials: { slots: [] }",
      "  filesystem: { paths: [] }",
      "  processes: false",
      "  ports: { names: [postgres] }",
      "  docker: {}",
      "",
    ].join("\n");
    const result = parseManifest(yaml, "/fake/roubo-plugin.yaml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("component");
      expect(result.manifest.contractVersion).toBe(1);
    }
  });
});

describe("PluginManifestSchema: ports / docker permission categories (FR-001/FR-011)", () => {
  it("accepts a ports object naming bench port keys", () => {
    const manifest = makeManifest({
      kind: "component",
      contractVersion: 1,
      permissions: {
        ...makeManifest().permissions,
        ports: { names: ["postgres"] },
      },
    });
    const result = PluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions.ports).toEqual({ names: ["postgres"] });
    }
  });

  it("accepts ports: false", () => {
    const manifest = makeManifest({
      permissions: { ...makeManifest().permissions, ports: false },
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("accepts a docker object", () => {
    const manifest = makeManifest({
      kind: "component",
      contractVersion: 1,
      permissions: { ...makeManifest().permissions, docker: {} },
    });
    const result = PluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.permissions.docker).toEqual({});
    }
  });

  it("accepts docker: false", () => {
    const manifest = makeManifest({
      permissions: { ...makeManifest().permissions, docker: false },
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("rejects a malformed ports value (neither false nor a names object)", () => {
    const manifest = makeManifest({
      permissions: {
        ...makeManifest().permissions,
        ports: true as unknown as false,
      },
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects a ports object with an unknown key", () => {
    const manifest = makeManifest({
      permissions: {
        ...makeManifest().permissions,
        ports: { names: ["x"], extra: true } as unknown as { names: string[] },
      },
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects a docker object with an unknown key", () => {
    const manifest = makeManifest({
      permissions: {
        ...makeManifest().permissions,
        docker: { privileged: true } as unknown as Record<string, never>,
      },
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(false);
  });
});

describe("PluginManifestSchema: contractVersion / descriptorSchemaVersion", () => {
  it("accepts contractVersion and descriptorSchemaVersion", () => {
    const manifest = makeManifest({
      kind: "component",
      contractVersion: 1,
      descriptorSchemaVersion: 1,
    });
    const result = PluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contractVersion).toBe(1);
      expect(result.data.descriptorSchemaVersion).toBe(1);
    }
  });

  it("omitting both version fields still validates (integration manifests)", () => {
    const result = PluginManifestSchema.safeParse(makeManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contractVersion).toBeUndefined();
      expect(result.data.descriptorSchemaVersion).toBeUndefined();
    }
  });

  it("rejects a non-positive contractVersion", () => {
    expect(PluginManifestSchema.safeParse(makeManifest({ contractVersion: 0 })).success).toBe(
      false,
    );
  });

  it("rejects a non-integer descriptorSchemaVersion", () => {
    expect(
      PluginManifestSchema.safeParse(makeManifest({ descriptorSchemaVersion: 1.5 })).success,
    ).toBe(false);
  });
});

describe("PluginManifestSchema: lifecycle (issue #401)", () => {
  it("accepts a long-running or one-shot lifecycle", () => {
    for (const lifecycle of ["long-running", "one-shot"] as const) {
      const result = PluginManifestSchema.safeParse(makeManifest({ kind: "component", lifecycle }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.lifecycle).toBe(lifecycle);
    }
  });

  it("omitting lifecycle still validates (defaults are applied by the reader, not the schema)", () => {
    const result = PluginManifestSchema.safeParse(makeManifest());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lifecycle).toBeUndefined();
  });

  it("rejects an unknown lifecycle value", () => {
    const manifest = { ...makeManifest(), lifecycle: "batch" };
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(false);
  });
});

describe("PluginManifestSchema: roubo range validation (FR-001)", () => {
  for (const valid of ["^1.0.0", "~1.2.0", ">=1.3.0", "1.x", "*", "1.2.3 - 2.0.0", "1 || 2"]) {
    it(`accepts a valid roubo range: ${valid}`, () => {
      expect(PluginManifestSchema.safeParse(makeManifest({ roubo: valid })).success).toBe(true);
    });
  }

  for (const bad of ["not-a-range", "^^1.0.0", ">=>1.0.0", "1.2.3.4.5", "abc || def"]) {
    it(`rejects a malformed roubo range: ${bad}`, () => {
      const result = PluginManifestSchema.safeParse(makeManifest({ roubo: bad }));
      expectFieldError(result, "roubo");
    });
  }

  it("rejects an empty roubo string", () => {
    expectFieldError(PluginManifestSchema.safeParse(makeManifest({ roubo: "" })), "roubo");
  });
});

describe("PluginManifestSchema: forward-compat passthrough", () => {
  it("accepts unknown permission categories so future 1.x minors can add them", () => {
    const manifest = {
      ...makeManifest(),
      permissions: {
        ...makeManifest().permissions,
        // A category not yet known to this host version; .passthrough() accepts it.
        gpu: { devices: ["nvidia0"] },
      },
    } as unknown as PluginManifest;
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe("Bundled plugin manifests ship default excludedStatuses (TC-124, FR-064)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pluginsDir = resolve(here, "..", "plugins");

  async function loadManifest(pluginId: string): Promise<PluginManifest> {
    const { parseManifest } = await import("./plugin-manifest.js");
    const file = resolve(pluginsDir, pluginId, "roubo-plugin.yaml");
    const result = parseManifest(readFileSync(file, "utf-8"), file);
    if (!result.ok) throw new Error(`Failed to parse ${file}: ${JSON.stringify(result)}`);
    return result.manifest;
  }

  it("github.com plugin ships the canonical default set mapped to native state strings", async () => {
    const manifest = await loadManifest("github-com");
    expect(manifest.defaultIntegrationConfig?.excludedStatuses).toEqual([
      "Closed",
      "Done",
      "Resolved",
      "In review",
      "PR open",
      "Waiting on reviewer",
    ]);
  });

  it("GHE plugin ships the same default set as github.com", async () => {
    const gh = await loadManifest("github-com");
    const ghe = await loadManifest("ghe");
    expect(ghe.defaultIntegrationConfig?.excludedStatuses).toEqual(
      gh.defaultIntegrationConfig?.excludedStatuses,
    );
  });

  it("Jira plugin ships status-name fallback defaults using Jira-native state strings", async () => {
    // Category-first exclusion is the default source of truth; this name list is
    // the best-effort fallback used only when an instance rejects `statusCategory`
    // in JQL. For the only-to-do default (FR-012 / issue #558) it names both the
    // In-Progress-category statuses ("In Progress", "In Review") and the
    // Done-category statuses, so an unsupported instance excludes the same intent.
    const manifest = await loadManifest("jira-self-hosted");
    expect(manifest.defaultIntegrationConfig?.excludedStatuses).toEqual([
      "In Progress",
      "In Review",
      "Closed",
      "Done",
      "Resolved",
    ]);
  });

  it("Jira plugin seeds the only-to-do excludedStatusCategories default (FR-012, issue #558)", async () => {
    // Deliberate flip from the prior Done-only default: the cut list defaults to
    // excluding both In Progress and Done so only ready-to-pick-up To-Do items
    // show. Surfaced to existing users by the one-time migration banner (FR-018).
    const manifest = await loadManifest("jira-self-hosted");
    expect(manifest.defaultIntegrationConfig?.excludedStatusCategories).toEqual([
      "In Progress",
      "Done",
    ]);
  });
});

describe("PluginDefaultIntegrationConfigSchema excludedStatusCategories (FR-010, TC-003)", () => {
  it("accepts a defaultIntegrationConfig with excludedStatusCategories", () => {
    const result = PluginDefaultIntegrationConfigSchema.safeParse({
      excludedStatuses: ["Done"],
      excludedStatusCategories: ["Done"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty-string status category", () => {
    const result = PluginDefaultIntegrationConfigSchema.safeParse({
      excludedStatusCategories: [""],
    });
    expect(result.success).toBe(false);
  });
});

describe("Bundled github.com / GHE plugin manifests declare per-source alert booleans (TC-135, FR-074)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pluginsDir = resolve(here, "..", "plugins");

  async function loadManifest(pluginId: string): Promise<PluginManifest> {
    const { parseManifest } = await import("./plugin-manifest.js");
    const file = resolve(pluginsDir, pluginId, "roubo-plugin.yaml");
    const result = parseManifest(readFileSync(file, "utf-8"), file);
    if (!result.ok) throw new Error(`Failed to parse ${file}: ${JSON.stringify(result)}`);
    return result.manifest;
  }

  function sourceItemProperties(manifest: PluginManifest): Record<string, Record<string, unknown>> {
    const configSchema = manifest.configSchema as Record<string, unknown> | undefined;
    const properties = configSchema?.properties as Record<string, Record<string, unknown>>;
    const sources = properties?.sources;
    const items = sources?.items as Record<string, unknown>;
    return items.properties as Record<string, Record<string, unknown>>;
  }

  function sourceItemRequired(manifest: PluginManifest): string[] {
    const configSchema = manifest.configSchema as Record<string, unknown> | undefined;
    const properties = configSchema?.properties as Record<string, Record<string, unknown>>;
    const items = properties.sources.items as Record<string, unknown>;
    return (items.required as string[]) ?? [];
  }

  for (const pluginId of ["github-com", "ghe"] as const) {
    describe(`${pluginId} manifest`, () => {
      it("declares includeCodeQLAlerts as an optional boolean defaulting to false", async () => {
        const manifest = await loadManifest(pluginId);
        const props = sourceItemProperties(manifest);
        expect(props.includeCodeQLAlerts).toMatchObject({ type: "boolean", default: false });
        expect(sourceItemRequired(manifest)).not.toContain("includeCodeQLAlerts");
      });

      it("declares includeSecretScanningAlerts as an optional boolean defaulting to false", async () => {
        const manifest = await loadManifest(pluginId);
        const props = sourceItemProperties(manifest);
        expect(props.includeSecretScanningAlerts).toMatchObject({
          type: "boolean",
          default: false,
        });
        expect(sourceItemRequired(manifest)).not.toContain("includeSecretScanningAlerts");
      });

      it("declares includeDependabotAlerts as an optional boolean defaulting to false", async () => {
        const manifest = await loadManifest(pluginId);
        const props = sourceItemProperties(manifest);
        expect(props.includeDependabotAlerts).toMatchObject({ type: "boolean", default: false });
        expect(sourceItemRequired(manifest)).not.toContain("includeDependabotAlerts");
      });
    });
  }
});

describe("schema/roubo-plugin.schema.json: JSON Schema artifact", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const jsonSchemaPath = resolve(here, "..", "schema", "roubo-plugin.schema.json");
  const jsonSchema = JSON.parse(readFileSync(jsonSchemaPath, "utf-8")) as Record<string, unknown>;

  it("declares the expected top-level metadata", () => {
    expect(jsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(jsonSchema.title).toBe("Roubo Plugin Manifest");
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.additionalProperties).toBe(false);
  });

  it("required list matches the zod schema's required top-level keys", () => {
    expect(jsonSchema.required).toEqual([
      "id",
      "name",
      "version",
      "description",
      "kind",
      "roubo",
      "entry",
      "permissions",
    ]);
  });

  it("permissions sub-tree requires all four categories", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.permissions.required).toEqual([
      "network",
      "credentials",
      "filesystem",
      "processes",
    ]);
    expect(properties.permissions.additionalProperties).toBe(true);
  });

  it("kind enum accepts integration and component (lockstep with zod)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.kind.enum).toEqual(["integration", "component"]);
  });

  it("declares optional contractVersion and descriptorSchemaVersion integers (lockstep with zod)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.contractVersion).toMatchObject({ type: "integer", minimum: 1 });
    expect(properties.descriptorSchemaVersion).toMatchObject({ type: "integer", minimum: 1 });
    const required = jsonSchema.required as string[];
    expect(required).not.toContain("contractVersion");
    expect(required).not.toContain("descriptorSchemaVersion");
  });

  it("declares an optional lifecycle enum (lockstep with zod, issue #401)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.lifecycle).toMatchObject({
      type: "string",
      enum: ["long-running", "one-shot"],
    });
    expect((jsonSchema.required as string[]).includes("lifecycle")).toBe(false);
  });

  it("permissions sub-tree declares ports and docker categories (lockstep with zod)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    const permProps = properties.permissions.properties as Record<string, unknown>;
    expect(permProps.ports).toBeDefined();
    expect(permProps.docker).toBeDefined();
    // ports and docker are not required (optional component categories).
    expect(properties.permissions.required).not.toContain("ports");
    expect(properties.permissions.required).not.toContain("docker");
  });

  it("declares icon as an optional bounded string", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.icon).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 16384,
    });
    expect((jsonSchema.required as string[]).includes("icon")).toBe(false);
  });

  it("capabilities declares the tracker-action flags as optional booleans (lockstep with zod)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    const capabilities = properties.capabilities as Record<string, unknown>;
    expect(capabilities.additionalProperties).toBe(false);
    const capProps = capabilities.properties as Record<string, { type: string }>;
    expect(Object.keys(capProps).sort()).toEqual(["supportsBlockingLinks", "supportsCreateIssue"]);
    expect(capProps.supportsCreateIssue.type).toBe("boolean");
    expect(capProps.supportsBlockingLinks.type).toBe("boolean");
    // capabilities itself stays optional.
    expect((jsonSchema.required as string[]).includes("capabilities")).toBe(false);
  });

  it("defaultIntegrationConfig declares both excludedStatuses and excludedStatusCategories (lockstep with zod)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    const defaults = properties.defaultIntegrationConfig as Record<string, unknown>;
    expect(defaults.additionalProperties).toBe(false);
    const defaultProps = defaults.properties as Record<string, unknown>;
    expect(Object.keys(defaultProps).sort()).toEqual([
      "excludedStatusCategories",
      "excludedStatuses",
    ]);
  });
});

describe("RouboConfigSchema non-regression", () => {
  it("a minimal roubo.yaml with no integration block still validates", () => {
    const result = RouboConfigSchema.safeParse({
      project: {
        name: "test-project",
        displayName: "Test Project",
        repo: "org/test-project",
      },
      layout: { type: "single-repo" },
      components: { backend: { plugin: { id: "process" }, config: { command: "dotnet run" } } },
      ports: { backend: { base: 5000 } },
      benches: { max: 5 },
    });
    expect(result.success).toBe(true);
  });
});
