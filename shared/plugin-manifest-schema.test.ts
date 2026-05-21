import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PluginManifestSchema, type PluginManifest } from "./plugin-manifest-schema.js";
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

describe("PluginManifestSchema — TC-006 happy paths", () => {
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
      capabilities: { prSync: true },
    });
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe("PluginManifestSchema — missing required top-level fields", () => {
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

describe("PluginManifestSchema — missing required permission categories", () => {
  const categories = ["network", "credentials", "filesystem", "processes"] as const;

  for (const category of categories) {
    it(`rejects manifest missing permissions.${category}`, () => {
      const base = makeManifest();
      const manifest = { ...base, permissions: omitField(base.permissions, category) };
      expectFieldError(PluginManifestSchema.safeParse(manifest), `permissions.${category}`);
    });
  }
});

describe("PluginManifestSchema — strict top-level", () => {
  it("rejects unknown top-level fields", () => {
    const manifest = { ...makeManifest(), unexpectedField: "nope" } as unknown as PluginManifest;
    const result = PluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
    if (result.success) return;
    const hasUnrecognized = result.error.issues.some((issue) => issue.code === "unrecognized_keys");
    expect(hasUnrecognized).toBe(true);
  });
});

describe("PluginManifestSchema — value validation", () => {
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

describe("PluginManifestSchema — forward-compat passthrough", () => {
  it("accepts unknown permission categories so future 1.x minors can add them", () => {
    const manifest = {
      ...makeManifest(),
      permissions: {
        ...makeManifest().permissions,
        ports: { allow: [3000] },
      },
    } as unknown as PluginManifest;
    expect(PluginManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe("schema/roubo-plugin.schema.json — JSON Schema artifact", () => {
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
});

describe("RouboConfigSchema non-regression", () => {
  it("a minimal roubo.yaml with no integration block still validates", () => {
    const result = RouboConfigSchema.safeParse({
      project: {
        name: "test-project",
        displayName: "Test Project",
        type: "web",
        repo: "org/test-project",
      },
      layout: { type: "single-repo" },
      components: { backend: { type: "process", command: "dotnet run" } },
      ports: { backend: { base: 5000 } },
      benches: { max: 5 },
    });
    expect(result.success).toBe(true);
  });
});
