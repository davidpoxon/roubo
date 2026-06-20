import { describe, it, expect } from "vitest";
import type { PluginManifest, RouboConfig } from "@roubo/shared";
import { validateComponentBindings } from "./component-binding-validator.js";

function makeManifest(
  overrides: Partial<PluginManifest> & Pick<PluginManifest, "id">,
): PluginManifest {
  return {
    name: "Test Component",
    version: "1.0.0",
    description: "A component plugin for tests",
    kind: "component",
    roubo: "*",
    entry: "index.js",
    permissions: {
      network: { hosts: [] },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: false,
    },
    ...overrides,
  };
}

function makeComponents(components: RouboConfig["components"]): Pick<RouboConfig, "components"> {
  return { components };
}

describe("validateComponentBindings", () => {
  it("accepts a binding to a known plugin whose config passes the configSchema", () => {
    const manifests = [
      makeManifest({
        id: "process",
        configSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      }),
    ];
    const config = makeComponents({
      api: { plugin: { id: "process" }, config: { command: "npm start" } },
    });

    expect(validateComponentBindings(config, manifests)).toEqual([]);
  });

  it("accepts a binding when the plugin declares no configSchema (config is opaque)", () => {
    const manifests = [makeManifest({ id: "anything" })];
    const config = makeComponents({
      svc: { plugin: { id: "anything" }, config: { whatever: 123, nested: { ok: true } } },
    });

    expect(validateComponentBindings(config, manifests)).toEqual([]);
  });

  it("rejects a binding to an unknown plugin id with a clear error", () => {
    const manifests = [makeManifest({ id: "process" })];
    const config = makeComponents({
      db: { plugin: { id: "postgres" }, config: {} },
    });

    const errors = validateComponentBindings(config, manifests);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("components.db.plugin.id");
    expect(errors[0].message).toContain("postgres");
    expect(errors[0].message).toMatch(/unknown/i);
  });

  it("rejects a config block that fails the plugin's configSchema (missing required)", () => {
    const manifests = [
      makeManifest({
        id: "process",
        configSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      }),
    ];
    const config = makeComponents({
      api: { plugin: { id: "process" }, config: {} },
    });

    const errors = validateComponentBindings(config, manifests);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("components.api.config.command");
  });

  it("rejects a config block with a wrong-typed property", () => {
    const manifests = [
      makeManifest({
        id: "database",
        configSchema: {
          type: "object",
          properties: { port: { type: "number" } },
          additionalProperties: false,
        },
      }),
    ];
    const config = makeComponents({
      db: { plugin: { id: "database" }, config: { port: "not-a-number" } },
    });

    const errors = validateComponentBindings(config, manifests);
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe("components.db.config.port");
  });

  it("rejects an unexpected property when the configSchema forbids additionalProperties", () => {
    const manifests = [
      makeManifest({
        id: "process",
        configSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          additionalProperties: false,
        },
      }),
    ];
    const config = makeComponents({
      api: { plugin: { id: "process" }, config: { command: "x", bogus: true } },
    });

    const errors = validateComponentBindings(config, manifests);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("bogus");
  });

  it("validates each binding independently and reports all failures", () => {
    const manifests = [
      makeManifest({
        id: "process",
        configSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      }),
    ];
    const config = makeComponents({
      good: { plugin: { id: "process" }, config: { command: "ok" } },
      bad: { plugin: { id: "process" }, config: {} },
      unknown: { plugin: { id: "nope" }, config: {} },
    });

    const errors = validateComponentBindings(config, manifests);
    const paths = errors.map((e) => e.path);
    expect(paths).toContain("components.bad.config.command");
    expect(paths).toContain("components.unknown.plugin.id");
    expect(paths).not.toContain("components.good.config.command");
  });

  it("returns no errors for an empty components map", () => {
    expect(validateComponentBindings(makeComponents({}), [])).toEqual([]);
  });

  it("preserves dependsOn at the binding level without flagging it", () => {
    const manifests = [
      makeManifest({
        id: "process",
        configSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      }),
      makeManifest({ id: "database" }),
    ];
    const config = makeComponents({
      db: { plugin: { id: "database" }, config: {} },
      api: { plugin: { id: "process" }, config: { command: "npm start" }, dependsOn: ["db"] },
    });

    // dependsOn lives on the binding, not inside the plugin-owned config block,
    // so it never reaches the plugin's configSchema and is never rejected.
    expect(validateComponentBindings(config, manifests)).toEqual([]);
  });
});
