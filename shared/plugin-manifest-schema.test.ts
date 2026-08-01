import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  PluginManifestSchema,
  PluginDefaultIntegrationConfigSchema,
  isValidAgentInstallLocation,
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

  it("accepts componentMode: imperative (the escape-hatch dispatch signal, #396)", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({ kind: "component", contractVersion: 1, componentMode: "imperative" }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.componentMode).toBe("imperative");
    }
  });

  it("accepts componentMode: declarative", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({ kind: "component", contractVersion: 1, componentMode: "declarative" }),
    );
    expect(result.success).toBe(true);
  });

  it("treats an omitted componentMode as valid (declarative is the default)", () => {
    const result = PluginManifestSchema.safeParse(makeManifest({ kind: "component" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.componentMode).toBeUndefined();
    }
  });

  it("rejects an unknown componentMode value", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        kind: "component",
        componentMode: "hybrid" as unknown as "imperative",
      }),
    );
    expectFieldError(result, "componentMode");
  });
});

describe("PluginManifestSchema: agent kind (AP-FR-001)", () => {
  // AP-TC-001: a well-formed kind: agent manifest passes schema validation and
  // kind: agent is an accepted value alongside integration and component.
  it("accepts a well-formed manifest with kind: agent (AP-TC-001)", () => {
    const manifest = makeManifest({
      id: "claude-code",
      name: "Claude Code",
      description: "Claude Code agent plugin",
      kind: "agent",
      agentCompatibility: { minVersion: "2.1.83", testedCeiling: "2.1.207" },
    });
    const result = PluginManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("agent");
      expect(result.data.agentCompatibility).toEqual({
        minVersion: "2.1.83",
        testedCeiling: "2.1.207",
      });
    }
  });

  it("accepts a minimal kind: agent manifest with no agentCompatibility block", () => {
    const result = PluginManifestSchema.safeParse(makeManifest({ kind: "agent" }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe("agent");
      expect(result.data.agentCompatibility).toBeUndefined();
    }
  });

  it("accepts agentCompatibility with only a minVersion (both fields optional)", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({ kind: "agent", agentCompatibility: { minVersion: "2.1.83" } }),
    );
    expect(result.success).toBe(true);
  });

  // AP-TC-007: a malformed agent manifest is rejected with an error naming the
  // offending field and the rule it violated, and no raw stack trace.
  it("rejects a malformed agentCompatibility version naming the field and rule (AP-TC-007)", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        kind: "agent",
        agentCompatibility: { minVersion: ">=2.1.83" },
      }),
    );
    expectFieldError(result, "agentCompatibility.minVersion");
    if (!result.success) {
      const errors = zodIssuesToValidationErrors(result.error.issues);
      const match = errors.find((e) => e.path === "agentCompatibility.minVersion");
      expect(match?.message).toBe(
        "Must be an exact semver version (major.minor.patch, no prerelease or build metadata)",
      );
    }
  });

  // Issue #669: a prerelease or build-metadata bound is valid semver but
  // uncomparable, because `compareVersions` splits on "." and `Number("111-beta")`
  // is NaN, so it used to validate here and then classify every detected version
  // `below-floor`. Both bounds now refuse the shape at authoring time, matching
  // VersionProbeSpecSchema on the descriptor side (#661).
  const UNCOMPARABLE_BOUNDS = ["2.1.111-beta.1", "2.1.111+build.5"];

  it.each(UNCOMPARABLE_BOUNDS)("rejects an uncomparable minVersion (%s)", (minVersion) => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({ kind: "agent", agentCompatibility: { minVersion } }),
    );
    expectFieldError(result, "agentCompatibility.minVersion");
  });

  it.each(UNCOMPARABLE_BOUNDS)("rejects an uncomparable testedCeiling (%s)", (testedCeiling) => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({ kind: "agent", agentCompatibility: { testedCeiling } }),
    );
    expectFieldError(result, "agentCompatibility.testedCeiling");
  });

  it("still accepts a bare major.minor.patch window on both bounds", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        kind: "agent",
        agentCompatibility: { minVersion: "2.1.83", testedCeiling: "2.1.207" },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a malformed testedCeiling version naming the field", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        kind: "agent",
        agentCompatibility: { testedCeiling: "latest" },
      }),
    );
    expectFieldError(result, "agentCompatibility.testedCeiling");
  });

  it("rejects an unknown key inside agentCompatibility (strict)", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        kind: "agent",
        agentCompatibility: { maxVersion: "2.2.0" } as unknown as { minVersion: string },
      }),
    );
    expect(result.success).toBe(false);
  });

  // #712: per-agent well-known install locations live on the manifest, so an
  // agent CLI other than `claude` resolves through the host's fallback without
  // core growing another per-agent branch.
  describe("agentInstallLocations (#712)", () => {
    it("accepts absolute and ~/-prefixed locations on a kind: agent manifest", () => {
      const result = PluginManifestSchema.safeParse(
        makeManifest({
          kind: "agent",
          agentInstallLocations: [
            "~/.local/bin/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
          ],
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        // Order is the probe order, so it must survive parsing untouched.
        expect(result.data.agentInstallLocations).toEqual([
          "~/.local/bin/codex",
          "/opt/homebrew/bin/codex",
          "/usr/local/bin/codex",
        ]);
      }
    });

    it("stays optional, so an agent manifest that omits it validates unchanged", () => {
      const result = PluginManifestSchema.safeParse(makeManifest({ kind: "agent" }));
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.agentInstallLocations).toBeUndefined();
    });

    it("rejects an empty list, which would silently mean nothing at all", () => {
      const result = PluginManifestSchema.safeParse(
        makeManifest({ kind: "agent", agentInstallLocations: [] }),
      );
      expectFieldError(result, "agentInstallLocations");
    });

    // A candidate list is what the host probes and may spawn from, so every
    // shape that could name something other than a fixed install location is
    // refused at authoring time rather than dropped at resolution time.
    it.each([
      ["a relative path", "bin/codex"],
      ["a bare name", "codex"],
      ["a parent-directory escape", "/opt/homebrew/bin/../../../etc/codex"],
      ["a ~/ parent-directory escape", "~/../../etc/codex"],
      ["an unresolved template", "{{workspace}}/bin/codex"],
      ["a bare ~ with no separator", "~codex"],
    ])("rejects %s", (_label, location) => {
      const result = PluginManifestSchema.safeParse(
        makeManifest({ kind: "agent", agentInstallLocations: [location] }),
      );
      expectFieldError(result, "agentInstallLocations.0");
    });

    it("rejects the field on a non-agent manifest rather than ignoring it", () => {
      const result = PluginManifestSchema.safeParse(
        makeManifest({ kind: "integration", agentInstallLocations: ["/usr/local/bin/codex"] }),
      );
      expectFieldError(result, "agentInstallLocations");
    });

    it("surfaces a malformed location through parseManifest naming the field", async () => {
      const { parseManifest } = await import("./plugin-manifest.js");
      const yaml = [
        "id: codex",
        "name: Codex CLI",
        "version: 1.0.0",
        "description: Codex agent plugin",
        "kind: agent",
        "roubo: ^1.0.0",
        "entry: ./dist/index.js",
        "agentInstallLocations:",
        "  - bin/codex",
        "permissions:",
        "  network: { hosts: [] }",
        "  credentials: { slots: [] }",
        "  filesystem: { paths: [] }",
        "  processes: false",
        "",
      ].join("\n");
      const result = parseManifest(yaml, "/fake/roubo-plugin.yaml");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("schema");
        expect(result.error.path).toBe("agentInstallLocations.0");
        expect(result.error.message).not.toMatch(/\n\s+at\s/);
      }
    });
  });

  it("surfaces the malformed agent field through parseManifest with no raw stack trace (AP-TC-007)", async () => {
    const { parseManifest } = await import("./plugin-manifest.js");
    const yaml = [
      "id: claude-code",
      "name: Claude Code",
      "version: 1.0.0",
      "description: Claude Code agent plugin",
      "kind: agent",
      "roubo: ^1.0.0",
      "entry: ./dist/index.js",
      "agentCompatibility:",
      "  minVersion: not-a-version",
      "permissions:",
      "  network: { hosts: [] }",
      "  credentials: { slots: [] }",
      "  filesystem: { paths: [] }",
      "  processes: false",
      "",
    ].join("\n");
    const result = parseManifest(yaml, "/fake/roubo-plugin.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("schema");
      expect(result.error.path).toBe("agentCompatibility.minVersion");
      expect(result.error.message).toBe(
        "agentCompatibility.minVersion: Must be an exact semver version (major.minor.patch, no prerelease or build metadata)",
      );
      // No raw stack trace leaks into the user-facing message.
      expect(result.error.message).not.toMatch(/\n\s+at\s/);
      expect(result.error.message).not.toContain(".ts:");
    }
  });

  it("discovers a kind: agent manifest through parseManifest", async () => {
    const { parseManifest } = await import("./plugin-manifest.js");
    const yaml = [
      "id: claude-code",
      "name: Claude Code",
      "version: 1.0.0",
      "description: Claude Code agent plugin",
      "kind: agent",
      "roubo: ^1.0.0",
      "entry: ./dist/index.js",
      "agentCompatibility: { minVersion: 2.1.83, testedCeiling: 2.1.207 }",
      "permissions:",
      "  network: { hosts: [] }",
      "  credentials: { slots: [] }",
      "  filesystem: { paths: [] }",
      "  processes: false",
      "",
    ].join("\n");
    const result = parseManifest(yaml, "/fake/roubo-plugin.yaml");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.kind).toBe("agent");
      expect(result.manifest.agentCompatibility?.minVersion).toBe("2.1.83");
    }
  });
});

describe("PluginManifestSchema: agent kind may not declare processes (#632, AP-NFR-001)", () => {
  it("accepts an agent manifest declaring processes: false", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        kind: "agent",
        permissions: { ...makeManifest().permissions, processes: false },
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an agent manifest declaring spawnable executables", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        kind: "agent",
        permissions: { ...makeManifest().permissions, processes: { executables: ["claude"] } },
      }),
    );
    expectFieldError(result, "permissions.processes");
  });

  it("rejects an agent manifest declaring an empty executables list (a declared block is still a block)", () => {
    const result = PluginManifestSchema.safeParse(
      makeManifest({
        kind: "agent",
        permissions: { ...makeManifest().permissions, processes: { executables: [] } },
      }),
    );
    expectFieldError(result, "permissions.processes");
  });

  // AP-NFR-004 regression guard: the gate is kind-scoped, so the kinds that
  // legitimately spawn today keep validating unchanged (issue #633 covers
  // confining those children).
  for (const kind of ["integration", "component"] as const) {
    it(`still accepts a ${kind} manifest declaring spawnable executables`, () => {
      const result = PluginManifestSchema.safeParse(
        makeManifest({
          kind,
          permissions: { ...makeManifest().permissions, processes: { executables: ["git"] } },
        }),
      );
      expect(result.success).toBe(true);
    });
  }

  it("surfaces the rejection through parseManifest at permissions.processes", async () => {
    const { parseManifest } = await import("./plugin-manifest.js");
    const yaml = [
      "id: claude-code",
      "name: Claude Code",
      "version: 1.0.0",
      "description: Claude Code agent plugin",
      "kind: agent",
      "roubo: ^1.0.0",
      "entry: ./dist/index.js",
      "permissions:",
      "  network: { hosts: [] }",
      "  credentials: { slots: [] }",
      "  filesystem: { paths: [] }",
      "  processes: { executables: [claude] }",
      "",
    ].join("\n");
    const result = parseManifest(yaml, "/fake/roubo-plugin.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("schema");
      expect(result.error.path).toBe("permissions.processes");
      expect(result.error.message).toContain("must declare `processes: false`");
    }
  });
});

describe("PluginManifestSchema: published manifests validate unchanged (AP-TC-013, AP-NFR-004)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pluginsDir = resolve(here, "..", "plugins");

  async function loadManifest(pluginId: string): Promise<PluginManifest> {
    const { parseManifest } = await import("./plugin-manifest.js");
    const file = resolve(pluginsDir, pluginId, "roubo-plugin.yaml");
    const result = parseManifest(readFileSync(file, "utf-8"), file);
    if (!result.ok) throw new Error(`Failed to parse ${file}: ${JSON.stringify(result)}`);
    return result.manifest;
  }

  const published: Array<{ id: string; kind: "integration" | "component" }> = [
    { id: "github-com", kind: "integration" },
    { id: "process", kind: "component" },
    { id: "database", kind: "component" },
  ];

  for (const { id, kind } of published) {
    it(`${id} validates unchanged and keeps kind: ${kind}, not misclassified as agent`, async () => {
      const manifest = await loadManifest(id);
      // Re-validate the parsed manifest against the widened schema.
      const result = PluginManifestSchema.safeParse(manifest);
      expect(result.success).toBe(true);
      expect(manifest.kind).toBe(kind);
      expect(manifest.kind).not.toBe("agent");
      // The agent-only block is absent on every existing manifest (zero new
      // required fields imposed on them).
      expect(manifest.agentCompatibility).toBeUndefined();
    });
  }
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

describe("Bundled github.com plugin manifest declares per-source alert booleans (TC-135, FR-074)", () => {
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

  for (const pluginId of ["github-com"] as const) {
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

  it("kind enum accepts integration, component and agent (lockstep with zod)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.kind.enum).toEqual(["integration", "component", "agent"]);
  });

  // This artifact is hand-authored and exempt from the schema-drift gate, so
  // this suite is the only thing keeping the agent processes gate in lockstep
  // with the superRefine on PluginManifestSchema (#632).
  it("declares the agent processes gate (lockstep with zod, #632)", () => {
    const allOf = jsonSchema.allOf as Array<Record<string, Record<string, unknown>>>;
    expect(Array.isArray(allOf)).toBe(true);
    const gate = allOf.find(
      (entry) =>
        (entry.if?.properties as Record<string, { const?: string }> | undefined)?.kind?.const ===
        "agent",
    );
    expect(gate).toBeDefined();
    expect(gate?.if.required).toContain("kind");
    const thenPermissions = (gate?.then.properties as Record<string, Record<string, unknown>>)
      .permissions;
    expect((thenPermissions.properties as Record<string, unknown>).processes).toEqual({
      const: false,
    });
  });

  it("declares an optional agentCompatibility object with minVersion, testedCeiling and probe (lockstep with zod)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    const agentCompatibility = properties.agentCompatibility as Record<string, unknown>;
    expect(agentCompatibility.type).toBe("object");
    expect(agentCompatibility.additionalProperties).toBe(false);
    const compatProps = agentCompatibility.properties as Record<string, { type: string }>;
    expect(Object.keys(compatProps).sort()).toEqual(["minVersion", "probe", "testedCeiling"]);
    expect(compatProps.minVersion.type).toBe("string");
    expect(compatProps.testedCeiling.type).toBe("string");
    // agentCompatibility itself stays optional (zero new required fields).
    expect((jsonSchema.required as string[]).includes("agentCompatibility")).toBe(false);
  });

  it("declares the agentCompatibility.probe directive with all three fields required (lockstep with zod)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    const compatProps = (properties.agentCompatibility as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    const probe = compatProps.probe;
    expect(probe.type).toBe("object");
    expect(probe.additionalProperties).toBe(false);
    expect(probe.required).toEqual(["command", "args", "parse"]);
    const probeProps = probe.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(probeProps).sort()).toEqual(["args", "command", "parse"]);
    expect(probeProps.command.type).toBe("string");
    expect(probeProps.args.type).toBe("array");
    expect(probeProps.parse.const).toBe("semver");
  });

  // Same reason as the processes gate above: this artifact is hand-authored and
  // exempt from schema-drift, so this suite is the only thing keeping the #712
  // field and its kind gate in lockstep with the zod schema.
  it("declares an optional agentInstallLocations array gated to kind: agent (lockstep with zod, #712)", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    const locations = properties.agentInstallLocations;
    expect(locations.type).toBe("array");
    expect(locations.minItems).toBe(1);
    const items = locations.items as Record<string, unknown>;
    expect(items.type).toBe("string");
    expect((jsonSchema.required as string[]).includes("agentInstallLocations")).toBe(false);

    const allOf = jsonSchema.allOf as Array<Record<string, Record<string, unknown>>>;
    const gate = allOf.find((entry) =>
      (entry.if?.required as string[] | undefined)?.includes("agentInstallLocations"),
    );
    expect(gate).toBeDefined();
    expect((gate?.then.properties as Record<string, { const?: string }>).kind.const).toBe("agent");
  });

  it("its item pattern accepts real install locations and rejects the shapes zod rejects", () => {
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>;
    const items = properties.agentInstallLocations.items as Record<string, string>;
    const pattern = new RegExp(items.pattern, "u");
    for (const ok of ["~/.local/bin/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]) {
      expect(pattern.test(ok)).toBe(true);
      expect(isValidAgentInstallLocation(ok)).toBe(true);
    }
    for (const bad of [
      "bin/codex",
      "codex",
      "/opt/homebrew/bin/../../../etc/codex",
      "~/../../etc/codex",
      "{{workspace}}/bin/codex",
      "~codex",
    ]) {
      expect(pattern.test(bad)).toBe(false);
      expect(isValidAgentInstallLocation(bad)).toBe(false);
    }
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
