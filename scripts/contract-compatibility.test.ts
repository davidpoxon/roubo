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

  // A schema with a `steps[]` union of options discriminated by `kind`.
  function withUnion(options: JsonSchema[]): JsonSchema {
    const out = clone(base);
    (out.properties as Record<string, JsonSchema>).steps = {
      type: "array",
      items: { anyOf: options },
    };
    return out;
  }
  function unionOptions(schema: JsonSchema): JsonSchema[] {
    const items = (schema.properties as Record<string, JsonSchema>).steps.items as JsonSchema;
    return items.anyOf as JsonSchema[];
  }
  const kindOption = (kind: string, field: string): JsonSchema => ({
    type: "object",
    properties: { kind: { type: "string", const: kind }, [field]: { type: "string" } },
    required: ["kind", field],
    additionalProperties: {},
  });
  const twoKinds = withUnion([kindOption("command", "command"), kindOption("open-url", "url")]);

  it("compares a union option by option: a new option or a field on one is additive, a lost option breaking", () => {
    expect(classifySchemaChange(twoKinds, clone(twoKinds))).toEqual({
      change: "none",
      reasons: [],
    });

    const grown = clone(twoKinds);
    const options = unionOptions(grown);
    (options[0].properties as JsonSchema).timeout_ms = { type: "integer" };
    options.push({
      type: "object",
      properties: { kind: { type: "string", const: "wait" } },
      required: ["kind"],
      additionalProperties: {},
    });
    expect(classifySchemaChange(twoKinds, grown)).toEqual({
      change: "additive",
      reasons: [
        "steps[].anyOf.command.timeout_ms: new optional property",
        'steps[]: anyOf gained the option kind="wait"',
      ],
    });

    const lost = clone(twoKinds);
    unionOptions(lost).pop();
    expect(classifySchemaChange(twoKinds, lost)).toEqual({
      change: "breaking",
      reasons: ['steps[]: anyOf lost the option kind="open-url"'],
    });

    const retyped = clone(twoKinds);
    (unionOptions(retyped)[1].properties as Record<string, JsonSchema>).url.type = "integer";
    expect(classifySchemaChange(twoKinds, retyped)).toEqual({
      change: "breaking",
      reasons: ['steps[].anyOf.open-url.url: type changed from "string" to "integer"'],
    });
  });

  it("matches union options by their discriminator const, not by position", () => {
    // An option inserted in the middle shifts the one after it: by position
    // that read as two changed options, by discriminator it is one new option.
    const inserted = clone(twoKinds);
    unionOptions(inserted).splice(1, 0, kindOption("copy-file", "from"));
    expect(classifySchemaChange(twoKinds, inserted)).toEqual({
      change: "additive",
      reasons: ['steps[]: anyOf gained the option kind="copy-file"'],
    });

    // Removing the first option leaves the second in place.
    const removed = clone(twoKinds);
    unionOptions(removed).shift();
    expect(classifySchemaChange(twoKinds, removed)).toEqual({
      change: "breaking",
      reasons: ['steps[]: anyOf lost the option kind="command"'],
    });

    // A renamed kind is a lost option and a gained one, so it is breaking.
    const renamed = clone(twoKinds);
    (unionOptions(renamed)[1].properties as Record<string, JsonSchema>).kind.const = "browse";
    expect(classifySchemaChange(twoKinds, renamed)).toEqual({
      change: "breaking",
      reasons: [
        'steps[]: anyOf lost the option kind="open-url"',
        'steps[]: anyOf gained the option kind="browse"',
      ],
    });

    // Reordering the options is not a change.
    const reordered = clone(twoKinds);
    unionOptions(reordered).reverse();
    expect(classifySchemaChange(twoKinds, reordered)).toEqual({ change: "none", reasons: [] });
  });

  it("prefers type, then kind, when more than one property could discriminate", () => {
    const typed = (type: string, kind: string): JsonSchema => ({
      type: "object",
      properties: {
        type: { type: "string", const: type },
        kind: { type: "string", const: kind },
        tag: { type: "string", const: `${type}/${kind}` },
      },
      required: ["type", "kind", "tag"],
      additionalProperties: {},
    });
    const both = withUnion([typed("a", "x"), typed("b", "y")]);
    const grown = clone(both);
    unionOptions(grown).splice(1, 0, typed("c", "z"));
    expect(classifySchemaChange(both, grown).reasons).toEqual([
      'steps[]: anyOf gained the option type="c"',
    ]);

    const kinded = withUnion([
      { type: "object", properties: { kind: { const: "x" }, tag: { const: 1 } } },
      { type: "object", properties: { kind: { const: "y" }, tag: { const: 2 } } },
    ]);
    const grownKind = clone(kinded);
    unionOptions(grownKind).unshift({
      type: "object",
      properties: { kind: { const: "w" }, tag: { const: 0 } },
    });
    expect(classifySchemaChange(kinded, grownKind).reasons).toEqual([
      'steps[]: anyOf gained the option kind="w"',
    ]);
  });

  it("falls back to comparing options in order when no property discriminates the union", () => {
    // Neither option pins a const, so there is nothing to match on.
    const scalars = withUnion([{ type: "string" }, { type: "integer" }]);
    expect(classifySchemaChange(scalars, clone(scalars))).toEqual({ change: "none", reasons: [] });

    const grown = clone(scalars);
    unionOptions(grown).push({ type: "boolean" });
    expect(classifySchemaChange(scalars, grown)).toEqual({
      change: "additive",
      reasons: ["steps[]: anyOf gained an option"],
    });

    const lost = clone(scalars);
    unionOptions(lost).pop();
    expect(classifySchemaChange(scalars, lost)).toEqual({
      change: "breaking",
      reasons: ["steps[]: anyOf lost an option"],
    });

    const retyped = clone(scalars);
    unionOptions(retyped)[1] = { type: "number" };
    expect(classifySchemaChange(scalars, retyped)).toEqual({
      change: "breaking",
      reasons: ['steps[].anyOf.1: type changed from "integer" to "number"'],
    });

    // A property every option pins to the same value tells none of them apart,
    // so it is no discriminator either.
    const sameConst = withUnion([
      { type: "object", properties: { v: { const: 1 }, a: { type: "string" } } },
      { type: "object", properties: { v: { const: 1 }, b: { type: "string" } } },
    ]);
    const sameConstGrown = clone(sameConst);
    unionOptions(sameConstGrown).push({ type: "object", properties: { v: { const: 1 } } });
    expect(classifySchemaChange(sameConst, sameConstGrown)).toEqual({
      change: "additive",
      reasons: ["steps[]: anyOf gained an option"],
    });
  });

  it("compares a root union the same way, and reads the version constants out of each root option", () => {
    const option = (kind: string, body: JsonSchema): JsonSchema => ({
      type: "object",
      properties: {
        $schema: { type: "string", const: "https://roubo.dev/schema/demo/v1.2.3.json" },
        schemaVersion: { type: "string", const: "1.2.3" },
        kind: { type: "string", const: kind },
        body,
      },
      required: ["$schema", "schemaVersion", "kind", "body"],
      additionalProperties: {},
    });
    const rootUnion: JsonSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://roubo.dev/schema/demo/v1.2.3.json",
      oneOf: [
        option("pause", { type: "object", properties: {}, additionalProperties: {} }),
        option("resume", { type: "object", properties: {}, additionalProperties: {} }),
      ],
    };
    expect(classifySchemaChange(rootUnion, clone(rootUnion))).toEqual({
      change: "none",
      reasons: [],
    });

    // A version bump rewrites the `$schema` / `schemaVersion` const in every
    // option: that is the version, not a change.
    const rebumped = clone(rootUnion);
    rebumped.$id = "https://roubo.dev/schema/demo/v1.3.0.json";
    for (const o of rebumped.oneOf as JsonSchema[]) {
      const props = o.properties as Record<string, JsonSchema>;
      props.$schema.const = rebumped.$id;
      props.schemaVersion.const = "1.3.0";
    }
    expect(classifySchemaChange(rootUnion, rebumped)).toEqual({ change: "none", reasons: [] });
    expect(checkContractCompatibility(rootUnion, rebumped).ok).toBe(false);

    const grown = clone(rootUnion);
    (grown.oneOf as JsonSchema[]).push(
      option("approval", { type: "object", properties: {}, additionalProperties: {} }),
    );
    expect(classifySchemaChange(rootUnion, grown)).toEqual({
      change: "additive",
      reasons: ['<root>: oneOf gained the option kind="approval"'],
    });

    const lost = clone(rootUnion);
    lost.oneOf = (lost.oneOf as JsonSchema[]).slice(0, 1);
    expect(classifySchemaChange(rootUnion, lost)).toEqual({
      change: "breaking",
      reasons: ['<root>: oneOf lost the option kind="resume"'],
    });

    const grownBody = clone(rootUnion);
    const body = ((grownBody.oneOf as JsonSchema[])[1].properties as Record<string, JsonSchema>)
      .body as JsonSchema;
    (body.properties as JsonSchema).reason = { type: "string" };
    expect(classifySchemaChange(rootUnion, grownBody)).toEqual({
      change: "additive",
      reasons: ["<root>.oneOf.resume.body.reason: new optional property"],
    });
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
