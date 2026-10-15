import { describe, expect, it } from "vitest";
import {
  checkContractCompatibility,
  classifySchemaChange,
  compareVersions,
  parseSchemaVersion,
  type JsonSchema,
} from "./contract-compatibility.js";

const base: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://roubo.dev/schema/demo/v1.2.3.json",
  title: "Demo",
  type: "object",
  properties: {
    $schema: { type: "string", const: "https://roubo.dev/schema/demo/v1.2.3.json" },
    schemaVersion: { type: "string", const: "1.2.3" },
    name: { type: "string", description: "a name" },
    tags: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["open", "closed"] },
    nested: {
      type: "object",
      properties: { depth: { type: "integer" } },
      required: ["depth"],
      additionalProperties: false,
    },
  },
  required: ["$schema", "schemaVersion", "name", "tags", "status", "nested"],
  additionalProperties: {},
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function bump(schema: JsonSchema, version: string): JsonSchema {
  const out = clone(schema);
  out.$id = `https://roubo.dev/schema/demo/v${version}.json`;
  const props = out.properties as Record<string, JsonSchema>;
  props.$schema.const = out.$id;
  props.schemaVersion.const = version;
  return out;
}

describe("parseSchemaVersion", () => {
  it("reads the semver segment of a published $id", () => {
    expect(parseSchemaVersion("https://roubo.dev/schema/demo/v1.2.3.json")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    });
  });

  it("throws on an $id with no version segment", () => {
    expect(() => parseSchemaVersion("https://roubo.dev/schema/demo.json")).toThrow(/version/);
    expect(() => parseSchemaVersion(undefined)).toThrow(/version/);
  });

  it("orders versions major, then minor, then patch", () => {
    const v = parseSchemaVersion;
    const id = (s: string) => `https://x/v${s}.json`;
    expect(compareVersions(v(id("2.0.0")), v(id("1.9.9")))).toBeGreaterThan(0);
    expect(compareVersions(v(id("1.1.0")), v(id("1.0.9")))).toBeGreaterThan(0);
    expect(compareVersions(v(id("1.0.1")), v(id("1.0.0")))).toBeGreaterThan(0);
    expect(compareVersions(v(id("1.0.0")), v(id("1.0.0")))).toBe(0);
  });
});

describe("classifySchemaChange", () => {
  it("sees no change in an identical schema, and ignores prose and the version constants", () => {
    expect(classifySchemaChange(base, clone(base))).toEqual({ change: "none", reasons: [] });
    const reworded = bump(base, "1.3.0");
    reworded.title = "Demo, reworded";
    (reworded.properties as Record<string, JsonSchema>).name.description = "a better name";
    expect(classifySchemaChange(base, reworded)).toEqual({ change: "none", reasons: [] });
  });

  it("calls a new optional property, an opened object and a grown enum additive", () => {
    const live = clone(base);
    const props = live.properties as Record<string, JsonSchema>;
    props.note = { type: "string" };
    (props.nested as JsonSchema).additionalProperties = {};
    props.status.enum = ["open", "closed", "provisional"];
    const result = classifySchemaChange(base, live);
    expect(result.change).toBe("additive");
    // Changes to existing properties come first, in schema order; new ones last.
    expect(result.reasons).toEqual([
      "status: enum gained a value",
      "nested: additionalProperties opened",
      "note: new optional property",
    ]);
  });

  it("calls a removed property, a new required property and a requiredness change breaking", () => {
    const live = clone(base);
    const props = live.properties as Record<string, JsonSchema>;
    delete props.tags;
    props.owner = { type: "string" };
    live.required = ["$schema", "schemaVersion", "status", "nested", "owner"];
    const result = classifySchemaChange(base, live);
    expect(result.change).toBe("breaking");
    expect(result.reasons).toEqual([
      "name: requiredness changed (required to optional)",
      "tags: property removed",
      "owner: new required property",
    ]);
  });

  it("calls a changed type, a lost enum value, closed additionalProperties and changed items breaking", () => {
    const live = clone(base);
    const props = live.properties as Record<string, JsonSchema>;
    props.name.type = "integer";
    props.status.enum = ["open"];
    props.tags.items = { type: "integer" };
    live.additionalProperties = false;
    const nested = props.nested.properties as Record<string, JsonSchema>;
    nested.depth.type = "number";
    const result = classifySchemaChange(base, live);
    expect(result.change).toBe("breaking");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'name: type changed from "string" to "integer"',
        'tags[]: type changed from "string" to "integer"',
        'status: enum lost "closed"',
        'nested.depth: type changed from "integer" to "number"',
        "<root>: additionalProperties closed",
      ]),
    );
  });

  it("ranks breaking above additive when both are present", () => {
    const live = clone(base);
    const props = live.properties as Record<string, JsonSchema>;
    props.note = { type: "string" };
    delete props.tags;
    live.required = (base.required as string[]).filter((k) => k !== "tags");
    const result = classifySchemaChange(base, live);
    expect(result.change).toBe("breaking");
    expect(result.reasons).toContain("tags: property removed");
    expect(result.reasons).toContain("note: new optional property");
  });
});

describe("checkContractCompatibility", () => {
  it("holds the version still when nothing changed", () => {
    expect(checkContractCompatibility(base, clone(base)).ok).toBe(true);
    const report = checkContractCompatibility(base, bump(base, "1.3.0"));
    expect(report.ok).toBe(false);
    expect(report.message).toMatch(/must stay at 1\.2\.3/);
  });

  it("asks at least a minor bump for an additive change", () => {
    const live = clone(base);
    (live.properties as Record<string, JsonSchema>).note = { type: "string" };
    const same = checkContractCompatibility(base, live);
    expect(same.ok).toBe(false);
    expect(same.message).toMatch(/at least a minor bump above 1\.2\.3/);
    // A patch bump does not announce a new field: 1.2.3 to 1.2.4 still fails.
    const patch = checkContractCompatibility(base, bump(live, "1.2.4"));
    expect(patch.ok).toBe(false);
    expect(patch.message).toMatch(/at least a minor bump above 1\.2\.3 \(live is 1\.2\.4\)/);
    expect(checkContractCompatibility(base, bump(live, "1.3.0")).ok).toBe(true);
    // A higher major with a lower minor (2.0.0 over 1.2.3) is above the baseline too.
    expect(checkContractCompatibility(base, bump(live, "2.0.0")).ok).toBe(true);
  });

  it("asks a major bump for a breaking change", () => {
    const live = clone(base);
    delete (live.properties as Record<string, JsonSchema>).tags;
    live.required = (base.required as string[]).filter((k) => k !== "tags");
    const minor = checkContractCompatibility(base, bump(live, "1.3.0"));
    expect(minor.ok).toBe(false);
    expect(minor.message).toMatch(/major bump above 1/);
    const major = checkContractCompatibility(base, bump(live, "2.0.0"));
    expect(major.ok).toBe(true);
    expect(major.reasons).toEqual(["tags: property removed"]);
  });
});
