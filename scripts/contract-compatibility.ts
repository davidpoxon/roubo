// Contract compatibility classifier (SB-NFR-007).
//
// Compares a freshly rendered JSON Schema against a committed baseline (the last
// published shape, kept under shared/__fixtures__/contract-baselines/) and says
// what kind of change separates them, then checks the semver in each `$id`
// against the rule a published contract follows:
//
//   none      the live version equals the baseline version
//   additive  the live MINOR or MAJOR is higher (a patch bump is not enough)
//   breaking  the live MAJOR is higher
//
// Additive: a new optional property, or an `additionalProperties` that went from
// closed to open, or an enum that gained a value, or an `anyOf` / `oneOf` that
// gained an option. Breaking: a removed property, a new required property, a
// property whose requiredness changed, a closed `additionalProperties` that was
// open, a changed type, const or format, an enum that lost a value, or a union
// that lost an option. `title` and `description` are prose and never count.
// A union's options are matched by their discriminator: the property that every
// option pins with a `const` (`type` or `kind` in the contracts here), so an
// option inserted in the middle is additive, not a shift of every option after
// it; see diffOptions. A union with no such property is compared in order.
// The root `$id` and the `$schema` / `schemaVersion` constants carry the version
// itself, so they are compared through the version rule, not as a change. A
// contract whose root is a union carries those constants in each root option,
// which the rule covers the same way.
//
// Pure: no IO. The suite feeds it the committed baseline and the live render.

export type JsonSchema = Record<string, unknown>;
export type ContractChange = "none" | "additive" | "breaking";

export interface SchemaVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface CompatibilityReport {
  ok: boolean;
  change: ContractChange;
  reasons: string[];
  baselineVersion: SchemaVersion;
  liveVersion: SchemaVersion;
  message: string;
}

const VERSION_IN_ID = /\/v(\d+)\.(\d+)\.(\d+)\.json$/;
const PROSE_KEYS = new Set(["title", "description"]);
const VERSION_CONST_PROPERTIES = new Set(["$schema", "schemaVersion"]);
// A contract whose root is a union (see schema/delivery-control.schema.json)
// carries its `$schema` / `schemaVersion` consts in each root option, not at
// the root itself. An option's path segment is its discriminator value, or its
// index when the union has no discriminator (see diffOptions).
const ROOT_OPTION = /^<root>\.(?:anyOf|oneOf)\.[^.]+$/;
// When more than one property could discriminate a union, prefer these, in
// this order, as the contracts in shared/ spell their discriminators.
const PREFERRED_DISCRIMINATORS = ["type", "kind"];

function carriesVersionConsts(path: string): boolean {
  return path === "" || ROOT_OPTION.test(path);
}

export function parseSchemaVersion(id: unknown): SchemaVersion {
  const match = typeof id === "string" ? VERSION_IN_ID.exec(id) : null;
  if (!match) {
    throw new Error(`schema $id ${String(id)} carries no /vX.Y.Z.json version segment`);
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function compareVersions(a: SchemaVersion, b: SchemaVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isSchema(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

interface Collector {
  additive: string[];
  breaking: string[];
}

function withoutConst(node: JsonSchema): JsonSchema {
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "const"));
}

function properties(node: JsonSchema): Record<string, unknown> {
  const value = node.properties;
  return isSchema(value) ? value : {};
}

function required(node: JsonSchema): Set<string> {
  const value = node.required;
  return new Set(Array.isArray(value) ? value.filter((v) => typeof v === "string") : []);
}

function diffNode(base: JsonSchema, live: JsonSchema, path: string, out: Collector): void {
  const keys = new Set([...Object.keys(base), ...Object.keys(live)]);
  for (const key of keys) {
    if (PROSE_KEYS.has(key)) continue;
    // The version lives in the root `$id`; the version rule compares it.
    if (key === "$id" && path === "") continue;
    const b = base[key];
    const l = live[key];
    switch (key) {
      case "properties":
        diffProperties(base, live, path, out);
        break;
      case "required":
        // Compared per property under "properties".
        break;
      case "additionalProperties":
        diffAdditionalProperties(b, l, path, out);
        break;
      case "items":
        if (isSchema(b) && isSchema(l)) diffNode(b, l, `${path}[]`, out);
        else if (!sameJson(b, l)) out.breaking.push(`${path || "<root>"}: items changed`);
        break;
      case "enum":
        diffEnum(b, l, path, out);
        break;
      case "anyOf":
      case "oneOf":
        diffOptions(key, b, l, path, out);
        break;
      default:
        if (!sameJson(b, l)) {
          out.breaking.push(
            `${path || "<root>"}: ${key} changed from ${JSON.stringify(b)} to ${JSON.stringify(l)}`,
          );
        }
    }
  }
}

function diffProperties(base: JsonSchema, live: JsonSchema, path: string, out: Collector): void {
  const baseProps = properties(base);
  const liveProps = properties(live);
  const baseRequired = required(base);
  const liveRequired = required(live);
  const at = (name: string) => (path ? `${path}.${name}` : name);

  for (const name of Object.keys(baseProps)) {
    if (!(name in liveProps)) {
      out.breaking.push(`${at(name)}: property removed`);
      continue;
    }
    if (baseRequired.has(name) !== liveRequired.has(name)) {
      out.breaking.push(
        `${at(name)}: requiredness changed (${baseRequired.has(name) ? "required" : "optional"} to ${liveRequired.has(name) ? "required" : "optional"})`,
      );
    }
    const b = baseProps[name];
    const l = liveProps[name];
    // A root `$schema` / `schemaVersion` const names the version: the version
    // rule covers it.
    if (
      carriesVersionConsts(path) &&
      VERSION_CONST_PROPERTIES.has(name) &&
      isSchema(b) &&
      isSchema(l)
    ) {
      diffNode(withoutConst(b), withoutConst(l), at(name), out);
      continue;
    }
    if (isSchema(b) && isSchema(l)) diffNode(b, l, at(name), out);
    else if (!sameJson(b, l)) out.breaking.push(`${at(name)}: schema changed`);
  }
  for (const name of Object.keys(liveProps)) {
    if (name in baseProps) continue;
    if (liveRequired.has(name)) out.breaking.push(`${at(name)}: new required property`);
    else out.additive.push(`${at(name)}: new optional property`);
  }
}

function diffAdditionalProperties(b: unknown, l: unknown, path: string, out: Collector): void {
  const where = path || "<root>";
  if (sameJson(b, l)) return;
  const baseClosed = b === false;
  const liveClosed = l === false;
  if (baseClosed && !liveClosed) {
    out.additive.push(`${where}: additionalProperties opened`);
    return;
  }
  if (!baseClosed && liveClosed) {
    out.breaking.push(`${where}: additionalProperties closed`);
    return;
  }
  if (isSchema(b) && isSchema(l)) {
    diffNode(b, l, `${where}.*`, out);
    return;
  }
  out.breaking.push(`${where}: additionalProperties changed`);
}

// The `const` an option pins on `name`, when it pins one.
function pinnedConst(option: unknown, name: string): unknown {
  if (!isSchema(option)) return undefined;
  const property = properties(option)[name];
  return isSchema(property) && "const" in property ? property.const : undefined;
}

// The properties that every option of `options` pins with a `const`, each to a
// value no other option of the same union pins: a property that two options
// share a value on cannot tell them apart.
function discriminatorCandidates(options: unknown[]): Set<string> {
  const out = new Set<string>();
  const first = options[0];
  if (!isSchema(first)) return out;
  for (const name of Object.keys(properties(first))) {
    const values = options.map((option) => pinnedConst(option, name));
    if (values.some((value) => value === undefined)) continue;
    if (new Set(values.map(stableStringify)).size !== values.length) continue;
    out.add(name);
  }
  return out;
}

// The discriminator of a union: a property that qualifies in both the baseline
// and the live options. `type` wins, then `kind`, then the first in schema
// order. Null when none qualifies, so diffOptions falls back to position.
function discriminatorOf(base: unknown[], live: unknown[]): string | null {
  const liveCandidates = discriminatorCandidates(live);
  const shared = [...discriminatorCandidates(base)].filter((name) => liveCandidates.has(name));
  if (shared.length === 0) return null;
  return PREFERRED_DISCRIMINATORS.find((name) => shared.includes(name)) ?? shared[0];
}

// An option's path segment: its discriminator value, bare when a string.
function optionSegment(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// A union is compared option by option. zod renders a discriminated union as
// `oneOf`, one option per kind (see schema/state-recipe.schema.json); a plain
// `anyOf` union is handled the same way. Each live option is matched to the
// baseline option that pins the same `const` on the union's discriminator, so
// an option inserted in the middle shifts nothing. The operator chose this over
// comparing options by position, which read an inserted option as a change to
// every option after it. An option present only in the live union is additive,
// as an enum gaining a value is; a baseline option with no live match is
// breaking, which also covers an option whose discriminator value changed (the
// old value is lost, the new one gained); a matched option is compared node by
// node under a path that names its discriminator value. A union whose options
// pin no common discriminator is compared in order, with the index in the
// path.
function diffOptions(key: string, b: unknown, l: unknown, path: string, out: Collector): void {
  const where = path || "<root>";
  if (sameJson(b, l)) return;
  if (!Array.isArray(b) || !Array.isArray(l)) {
    out.breaking.push(`${where}: ${key} changed`);
    return;
  }
  const discriminator = discriminatorOf(b, l);
  if (discriminator === null) {
    diffOptionsByPosition(key, b, l, where, out);
    return;
  }
  // Every option of both unions is a schema that pins the discriminator:
  // discriminatorOf checked so. Key each option by its pinned value.
  const valueOf = (option: unknown) => pinnedConst(option, discriminator);
  const label = (value: unknown) => `${discriminator}=${JSON.stringify(value)}`;
  const liveByValue = new Map<string, JsonSchema>();
  for (const option of l) liveByValue.set(stableStringify(valueOf(option)), option as JsonSchema);
  const baseValues = new Set(b.map((option) => stableStringify(valueOf(option))));
  for (const option of b) {
    const value = valueOf(option);
    const live = liveByValue.get(stableStringify(value));
    if (live === undefined) {
      out.breaking.push(`${where}: ${key} lost the option ${label(value)}`);
      continue;
    }
    diffNode(option as JsonSchema, live, `${where}.${key}.${optionSegment(value)}`, out);
  }
  for (const option of l) {
    const value = valueOf(option);
    if (baseValues.has(stableStringify(value))) continue;
    out.additive.push(`${where}: ${key} gained the option ${label(value)}`);
  }
}

// The fallback for a union with no discriminator: options are compared in
// order, and a longer live union has gained an option, a shorter one lost one.
function diffOptionsByPosition(
  key: string,
  b: unknown[],
  l: unknown[],
  where: string,
  out: Collector,
): void {
  const shared = Math.min(b.length, l.length);
  for (let i = 0; i < shared; i++) {
    const option = `${where}.${key}.${i}`;
    if (isSchema(b[i]) && isSchema(l[i])) diffNode(b[i], l[i], option, out);
    else if (!sameJson(b[i], l[i])) out.breaking.push(`${option}: option changed`);
  }
  if (l.length > b.length) out.additive.push(`${where}: ${key} gained an option`);
  if (b.length > l.length) out.breaking.push(`${where}: ${key} lost an option`);
}

function diffEnum(b: unknown, l: unknown, path: string, out: Collector): void {
  const where = path || "<root>";
  if (sameJson(b, l)) return;
  if (!Array.isArray(b) || !Array.isArray(l)) {
    out.breaking.push(`${where}: enum changed`);
    return;
  }
  const liveSet = new Set(l.map(stableStringify));
  const lost = b.filter((v) => !liveSet.has(stableStringify(v)));
  if (lost.length > 0) {
    out.breaking.push(`${where}: enum lost ${lost.map((v) => JSON.stringify(v)).join(", ")}`);
    return;
  }
  out.additive.push(`${where}: enum gained a value`);
}

export function classifySchemaChange(
  baseline: JsonSchema,
  live: JsonSchema,
): { change: ContractChange; reasons: string[] } {
  const out: Collector = { additive: [], breaking: [] };
  diffNode(baseline, live, "", out);
  if (out.breaking.length > 0) {
    return { change: "breaking", reasons: [...out.breaking, ...out.additive] };
  }
  if (out.additive.length > 0) return { change: "additive", reasons: out.additive };
  return { change: "none", reasons: [] };
}

export function checkContractCompatibility(
  baseline: JsonSchema,
  live: JsonSchema,
): CompatibilityReport {
  const baselineVersion = parseSchemaVersion(baseline.$id);
  const liveVersion = parseSchemaVersion(live.$id);
  const { change, reasons } = classifySchemaChange(baseline, live);
  const cmp = compareVersions(liveVersion, baselineVersion);
  const show = (v: SchemaVersion) => `${v.major}.${v.minor}.${v.patch}`;
  const verdict = (ok: boolean, message: string): CompatibilityReport => ({
    ok,
    change,
    reasons,
    baselineVersion,
    liveVersion,
    message,
  });
  if (change === "none") {
    return cmp === 0
      ? verdict(true, `no change at ${show(liveVersion)}`)
      : verdict(
          false,
          `no schema change, so the version must stay at ${show(baselineVersion)} (live is ${show(liveVersion)})`,
        );
  }
  if (change === "additive") {
    // At least a minor bump: a higher major, or the same major with a higher
    // minor. A patch bump alone (1.0.0 to 1.0.1) does not announce a new field.
    const minorOrMajorBumped =
      liveVersion.major > baselineVersion.major ||
      (liveVersion.major === baselineVersion.major && liveVersion.minor > baselineVersion.minor);
    return minorOrMajorBumped
      ? verdict(true, `additive change, version ${show(baselineVersion)} to ${show(liveVersion)}`)
      : verdict(
          false,
          `additive change needs at least a minor bump above ${show(baselineVersion)} (live is ${show(liveVersion)})`,
        );
  }
  return liveVersion.major > baselineVersion.major
    ? verdict(true, `breaking change, major ${baselineVersion.major} to ${liveVersion.major}`)
    : verdict(
        false,
        `breaking change needs a major bump above ${baselineVersion.major} (live is ${show(liveVersion)})`,
      );
}
