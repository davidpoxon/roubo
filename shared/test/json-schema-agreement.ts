// Key agreement between a hand-authored JSON Schema and the JSON Schema zod
// derives from the same contract (#1442). The hand-authored files under
// schema/ are exempt from the schema-drift gate, so this walk is what keeps
// them from rejecting keys that zod accepts, or accepting keys that zod
// rejects.
//
// Both schemas are walked down to every nested object, including each variant
// of a discriminated union. At each object the walk compares the keys it
// accepts, the keys it requires, and whether it rejects unknown keys. Value
// constraints (types, patterns, ranges) and cross-field gates are not compared.

export interface SchemaNode {
  properties?: Record<string, SchemaNode | boolean>;
  required?: string[];
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
  oneOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  allOf?: SchemaNode[];
  if?: SchemaNode;
  then?: SchemaNode;
  not?: SchemaNode;
  const?: unknown;
  enum?: unknown[];
}

// null means "no keys to compare below here": a leaf, or an open record or
// array of leaves.
type Shape =
  | null
  | { kind: "object"; required: string[]; closed: boolean; children: Record<string, Shape> }
  | { kind: "record"; value: Shape }
  | { kind: "array"; items: Shape }
  | { kind: "variants"; variants: Record<string, Shape> };

const asNode = (node: SchemaNode | boolean | undefined) =>
  typeof node === "object" ? node : undefined;

function objectShape(node: SchemaNode, extraRequired: string[], removed: Set<string>): Shape {
  const properties = node.properties ?? {};
  const keys = Object.keys(properties)
    .filter((k) => properties[k] !== false && !removed.has(k))
    .sort();
  return {
    kind: "object",
    required: [...new Set([...(node.required ?? []), ...extraRequired])].sort(),
    closed: node.additionalProperties === false,
    children: Object.fromEntries(keys.map((k) => [k, summarize(properties[k])])),
  };
}

// A hand-authored schema can model a zod discriminated union as one object plus
// `if: {properties: {<d>: {const|enum}}}` / `then` clauses, where `then` adds
// required keys and forbids others with `<key>: false` or `not: {required}`.
// Expand that into one object shape per discriminant value. Clauses that
// change no keys at this level yield identical variants, which collapse back
// into one object.
function expandConditionals(node: SchemaNode, conditionals: SchemaNode[]): Shape {
  const [d] = Object.keys(conditionals[0].if?.properties ?? {});
  const base = asNode(node.properties?.[d]);
  const values = base?.enum ?? [base?.const];
  const matches = (cond: SchemaNode, value: unknown) => {
    const test = asNode(cond.if?.properties?.[d]);
    return test?.const === value || (test?.enum ?? []).includes(value);
  };
  const variants: Record<string, Shape> = {};
  for (const value of values) {
    const thens = conditionals.filter((c) => matches(c, value)).map((c) => c.then ?? {});
    const removed = new Set(
      thens.flatMap((t) => [
        ...Object.keys(t.properties ?? {}).filter((k) => t.properties?.[k] === false),
        ...(t.not?.required ?? []),
      ]),
    );
    variants[String(value)] = objectShape(
      node,
      thens.flatMap((t) => t.required ?? []),
      removed,
    );
  }
  const distinct = new Set(Object.values(variants).map((v) => JSON.stringify(v)));
  return distinct.size === 1 ? Object.values(variants)[0] : { kind: "variants", variants };
}

// A union branch's discriminant is its one property pinned with `const`.
function discriminant(branch: SchemaNode): string {
  const pinned = Object.values(branch.properties ?? {}).find(
    (p) => typeof p === "object" && "const" in p,
  );
  return String(asNode(pinned)?.const);
}

// Only clauses that test a property's value discriminate variants. A clause
// gated on a key's presence (`if: {required: [k]}`) is a cross-field gate.
const discriminates = (c: SchemaNode) =>
  c.then !== undefined &&
  Object.values(c.if?.properties ?? {}).some(
    (p) => typeof p === "object" && ("const" in p || "enum" in p),
  );

function summarize(input: SchemaNode | boolean | undefined): Shape {
  const node = asNode(input);
  if (!node) return null;
  const branches = (node.oneOf ?? node.anyOf)?.filter((b) => b.properties);
  if (branches?.length === 1) return summarize(branches[0]);
  if (branches && branches.length > 1) {
    return {
      kind: "variants",
      variants: Object.fromEntries(branches.map((b) => [discriminant(b), summarize(b)])),
    };
  }
  if (node.properties) {
    const conditionals = [node, ...(node.allOf ?? [])].filter(discriminates);
    return conditionals.length > 0
      ? expandConditionals(node, conditionals)
      : objectShape(node, [], new Set());
  }
  if (node.items) {
    const items = summarize(node.items);
    return items && { kind: "array", items };
  }
  const value = summarize(node.additionalProperties);
  return value && { kind: "record", value };
}

const only = (a: string[], b: string[]) => a.filter((k) => !b.includes(k)).join(", ");

function diff(zod: Shape, json: Shape, path: string): string[] {
  const at = path || "(root)";
  if (zod === null || json === null) {
    return zod === json ? [] : [`${at}: nested keys only in ${zod ? "zod" : "JSON Schema"}`];
  }
  if (zod.kind !== json.kind) return [`${at}: zod has ${zod.kind}, JSON Schema has ${json.kind}`];
  switch (zod.kind) {
    case "object": {
      const other = json as typeof zod;
      const zodKeys = Object.keys(zod.children);
      const jsonKeys = Object.keys(other.children);
      const out: string[] = [];
      if (only(zodKeys, jsonKeys)) out.push(`${at}: keys only in zod: ${only(zodKeys, jsonKeys)}`);
      if (only(jsonKeys, zodKeys))
        out.push(`${at}: keys only in JSON Schema: ${only(jsonKeys, zodKeys)}`);
      if (only(zod.required, other.required))
        out.push(`${at}: required only in zod: ${only(zod.required, other.required)}`);
      if (only(other.required, zod.required))
        out.push(`${at}: required only in JSON Schema: ${only(other.required, zod.required)}`);
      if (zod.closed !== other.closed)
        out.push(`${at}: unknown keys rejected only in ${zod.closed ? "zod" : "JSON Schema"}`);
      for (const k of zodKeys.filter((k) => jsonKeys.includes(k))) {
        out.push(...diff(zod.children[k], other.children[k], path ? `${path}.${k}` : k));
      }
      return out;
    }
    case "record":
      return diff(zod.value, (json as typeof zod).value, `${path}.*`);
    case "array":
      return diff(zod.items, (json as typeof zod).items, `${path}[]`);
    case "variants": {
      const other = json as typeof zod;
      const zodNames = Object.keys(zod.variants);
      const jsonNames = Object.keys(other.variants);
      const out: string[] = [];
      if (only(zodNames, jsonNames))
        out.push(`${at}: variants only in zod: ${only(zodNames, jsonNames)}`);
      if (only(jsonNames, zodNames))
        out.push(`${at}: variants only in JSON Schema: ${only(jsonNames, zodNames)}`);
      for (const v of zodNames.filter((v) => jsonNames.includes(v))) {
        out.push(...diff(zod.variants[v], other.variants[v], `${path}<${v}>`));
      }
      return out;
    }
  }
}

/**
 * Every key disagreement between `zodJson` (the output of `z.toJSONSchema`,
 * best with `io: "input"` so defaulted keys count as optional) and the
 * hand-authored `handJson`, one line per disagreement, e.g.
 * `integration: keys only in zod: pageSize`. Paths use `.*` for a record value,
 * `[]` for an array item and `<v>` for the union variant whose discriminant is
 * `v`. Empty when the two agree.
 */
export function jsonSchemaKeyDiff(zodJson: SchemaNode, handJson: SchemaNode): string[] {
  return diff(summarize(zodJson), summarize(handJson), "");
}
