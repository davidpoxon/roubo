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
// closed to open, or an enum that gained a value, or a new `anyOf` member.
// Breaking: a removed property, a new required property, a property whose
// requiredness changed, a closed `additionalProperties` that was open, a changed
// type, const or format, an enum that lost a value, or an `anyOf` member that
// was removed or changed. `title` and `description` are prose and never count.
// The root `$id` and the `$schema` / `schemaVersion` constants carry the version
// itself, so they are compared through the version rule, not as a change.
//
// An `anyOf` is a union of members, each a full envelope. Members are matched
// by the `const` of their `type` property, so a member keeps its identity when
// the union grows around it; a member whose `type` carries no const (the
// catch-all, an open string) is matched by position among such members. The
// version constants live inside each member of a root union, so the exemption
// above applies inside a top-level member as well as at the root.
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
// The path of a member of a root `anyOf`: `anyOf[unit.changed]`, `anyOf[*]`.
const ROOT_MEMBER_PATH = /^anyOf\[[^\]]*\]$/;
const CATCH_ALL_KEY = "*";

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

// The root, or a member of a root union: where the version constants live.
function isEnvelopeRoot(path: string): boolean {
  return path === "" || ROOT_MEMBER_PATH.test(path);
}

// The identity of a union member: the const of its `type` property, or the
// catch-all key when `type` carries no const.
function memberKey(member: unknown): string {
  if (!isSchema(member)) return CATCH_ALL_KEY;
  const type = properties(member).type;
  if (isSchema(type) && typeof type.const === "string") return type.const;
  return CATCH_ALL_KEY;
}

// Members grouped by key, in order of first appearance.
function membersByKey(members: unknown[]): Map<string, unknown[]> {
  const groups = new Map<string, unknown[]>();
  for (const member of members) {
    const key = memberKey(member);
    const group = groups.get(key);
    if (group) group.push(member);
    else groups.set(key, [member]);
  }
  return groups;
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
        diffAnyOf(b, l, path, out);
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
    // A `$schema` / `schemaVersion` const at the root, or in a member of a root
    // union, names the version: the version rule covers it.
    const versionConst = isEnvelopeRoot(path) && VERSION_CONST_PROPERTIES.has(name);
    if (versionConst && isSchema(b) && isSchema(l)) {
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

// Union members are matched by key (see memberKey); members that share a key
// are matched by position within that key. A member the baseline lacks is
// additive: a reader at the baseline version routes its type to the catch-all.
// A member the live schema lacks is breaking, and so is any breaking change
// inside a member.
function diffAnyOf(b: unknown, l: unknown, path: string, out: Collector): void {
  const where = path || "<root>";
  if (sameJson(b, l)) return;
  if (!Array.isArray(b) || !Array.isArray(l)) {
    out.breaking.push(`${where}: anyOf changed`);
    return;
  }
  const baseGroups = membersByKey(b);
  const liveGroups = membersByKey(l);
  const at = (key: string, index: number) => {
    const member = `anyOf[${key}${index > 0 ? `#${index + 1}` : ""}]`;
    return path ? `${path}.${member}` : member;
  };

  for (const [key, baseMembers] of baseGroups) {
    const liveMembers = liveGroups.get(key) ?? [];
    baseMembers.forEach((bm, index) => {
      const lm = liveMembers[index];
      if (lm === undefined) {
        out.breaking.push(`${at(key, index)}: member removed`);
        return;
      }
      if (isSchema(bm) && isSchema(lm)) diffNode(bm, lm, at(key, index), out);
      else if (!sameJson(bm, lm)) out.breaking.push(`${at(key, index)}: member changed`);
    });
    for (let index = baseMembers.length; index < liveMembers.length; index++) {
      out.additive.push(`${at(key, index)}: member added`);
    }
  }
  for (const [key, liveMembers] of liveGroups) {
    if (baseGroups.has(key)) continue;
    liveMembers.forEach((_, index) => out.additive.push(`${at(key, index)}: member added`));
  }
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
