import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { artifacts, renderSchema, repoRoot } from "../scripts/generate-schema.js";
import {
  checkContractCompatibility,
  classifySchemaChange,
  parseSchemaVersion,
  type JsonSchema,
} from "../scripts/contract-compatibility.js";
import { scanFiles } from "../scripts/agent-identifier-guard.mjs";
import {
  DELIVERY_CONTROL_DURABILITY,
  DELIVERY_CONTROL_KINDS,
  DELIVERY_CONTROL_SCHEMA_ID,
  DELIVERY_CONTROL_SCHEMA_VERSION,
  DELIVERY_CONTROL_STATUSES,
  DeliveryControlSchema,
  DeliveryControlStatusSchema,
  validateDeliveryControl,
  validateDeliveryControlReadResponse,
  type DeliveryControlKind,
} from "./delivery-control-contract.js";
import { DELIVERY_TEXT_MAX_LENGTH } from "./delivery-observation-contract.js";

const FILE = "delivery-control.schema.json";
const SOURCE = join(repoRoot, "shared", "delivery-control-contract.ts");
const baselineDir = join(repoRoot, "shared", "__fixtures__", "contract-baselines");

function artifact() {
  const found = artifacts.find((a) => a.outPath.endsWith(FILE));
  if (!found) throw new Error(`no generated artifact for ${FILE}`);
  return found;
}

async function liveSchema(): Promise<JsonSchema> {
  const a = artifact();
  return JSON.parse(await renderSchema(a.schema, a.outPath));
}

interface PublishedPin {
  version: string;
  sha256: string;
}

function publishedPin(): PublishedPin {
  const pins: Record<string, PublishedPin> = JSON.parse(
    readFileSync(join(baselineDir, "published.json"), "utf8"),
  );
  const pin = pins[FILE];
  if (!pin) throw new Error(`published.json pins no baseline for ${FILE}`);
  return pin;
}

function baselineBytes(): string {
  return readFileSync(
    join(baselineDir, FILE.replace(".schema.json", ".baseline.schema.json")),
    "utf8",
  );
}

function baselineSchema(): JsonSchema {
  return JSON.parse(baselineBytes());
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The schema with its `$id` moved one semver step above its current version.
function bumped(schema: JsonSchema, step: "patch" | "minor" | "major"): JsonSchema {
  const v = parseSchemaVersion(schema.$id);
  let next = `${v.major}.${v.minor}.${v.patch + 1}`;
  if (step === "major") next = `${v.major + 1}.0.0`;
  if (step === "minor") next = `${v.major}.${v.minor + 1}.0`;
  const id = String(schema.$id).replace(/v\d+\.\d+\.\d+\.json$/, `v${next}.json`);
  return { ...schema, $id: id };
}

// zod renders the discriminated union as a root `oneOf`, one option per kind.
function options(schema: JsonSchema): JsonSchema[] {
  return schema.oneOf as JsonSchema[];
}

function optionProps(option: JsonSchema): Record<string, JsonSchema> {
  return option.properties as Record<string, JsonSchema>;
}

const REQUIRED_FIELDS = [
  "$schema",
  "schemaVersion",
  "delivery_id",
  "control_seq",
  "kind",
  "body",
  "durability",
  "issued_at",
  "status",
];

const FIELD_ORDER = [...REQUIRED_FIELDS.slice(0, 5), "target_id", ...REQUIRED_FIELDS.slice(5)];

const ALL_KINDS = [
  "decision-answer",
  "overturn",
  "steering-note",
  "role-change",
  "pause",
  "wind-down",
  "resume",
  "approval",
  "mode_switch",
  "review_accept",
  "thread_message",
];

const ALL_STATUSES = ["pending", "queued", "delivered", "applied", "rejected", "superseded"];

// One well-formed body per kind, and the body fields each kind requires.
const bodies: Record<DeliveryControlKind, Record<string, unknown>> = {
  "decision-answer": { option: "one file per unit" },
  overturn: { option: "one file per stack", reason: "the cache is per stack" },
  "steering-note": { note: "Keep the schema loose.", unit_ids: ["demo-unit-2"] },
  "role-change": { tier: "fast" },
  pause: {},
  "wind-down": { reason: "budget" },
  resume: {},
  approval: { reason: "reviewed" },
  mode_switch: { mode: "attended" },
  review_accept: {},
  thread_message: { text: "Why reject the trailing comma?" },
};
const requiredBodyFields: Record<DeliveryControlKind, string[]> = {
  "decision-answer": ["option"],
  overturn: ["option"],
  "steering-note": ["note", "unit_ids"],
  "role-change": ["tier"],
  pause: [],
  "wind-down": [],
  resume: [],
  approval: [],
  mode_switch: ["mode"],
  review_accept: [],
  thread_message: ["text"],
};
const targets: Partial<Record<DeliveryControlKind, string>> = {
  "decision-answer": "demo-decision-1",
  overturn: "demo-decision-1",
  "role-change": "unit-coder",
  approval: "demo-unit-2",
  review_accept: "demo-decision-2",
  thread_message: "demo-decision-2",
};

function controlOf(kind: DeliveryControlKind, control_seq = 1): Record<string, unknown> {
  return {
    $schema: DELIVERY_CONTROL_SCHEMA_ID,
    schemaVersion: DELIVERY_CONTROL_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    control_seq,
    kind,
    ...(targets[kind] ? { target_id: targets[kind] } : {}),
    body: bodies[kind],
    durability: DELIVERY_CONTROL_DURABILITY[kind],
    issued_at: "2026-10-16T09:00:00Z",
    status: "pending",
  };
}

const minimalControl = controlOf("decision-answer");

describe("delivery control contract: generated schema", () => {
  it("is zod in shared with a versioned $id at 1.0.0 and its committed JSON equals a fresh render", async () => {
    expect(DELIVERY_CONTROL_SCHEMA_VERSION).toBe("1.0.0");
    expect(DELIVERY_CONTROL_SCHEMA_ID).toMatch(/\/v1\.0\.0\.json$/);
    expect(DeliveryControlSchema.meta()?.$id).toBe(DELIVERY_CONTROL_SCHEMA_ID);

    // The generator lists it, and the committed artifact under schema/ is
    // byte-equal to a fresh render, which is what the CI drift gate checks.
    const a = artifact();
    const rendered = await renderSchema(a.schema, a.outPath);
    expect(readFileSync(a.outPath, "utf8")).toBe(rendered);
    expect(JSON.parse(rendered).$id).toBe(DELIVERY_CONTROL_SCHEMA_ID);
  });

  it("renders a root oneOf with one option per kind, each pinning kind and carrying the fields", async () => {
    const live = await liveSchema();
    expect(live.$id).toBe(DELIVERY_CONTROL_SCHEMA_ID);
    expect(live.properties).toBeUndefined();
    const kinds = options(live).map((o) => optionProps(o).kind.const);
    expect(kinds).toEqual(ALL_KINDS);
    expect(DELIVERY_CONTROL_KINDS).toEqual(kinds);
    for (const option of options(live)) {
      const props = optionProps(option);
      expect(props.$schema.const).toBe(DELIVERY_CONTROL_SCHEMA_ID);
      expect(props.schemaVersion.const).toBe(DELIVERY_CONTROL_SCHEMA_VERSION);
      expect(option.required).toEqual(REQUIRED_FIELDS);
      expect(Object.keys(props)).toEqual(FIELD_ORDER);
      expect(props.status.enum).toEqual(ALL_STATUSES);
      expect(props.durability.const).toBe(
        DELIVERY_CONTROL_DURABILITY[props.kind.const as DeliveryControlKind],
      );
      // Loose: the option and its body keep an unknown key.
      expect(option.additionalProperties).toEqual({});
      expect(props.body.additionalProperties).toEqual({});
    }
  });

  it("types the body per kind: each option requires that kind's body fields", async () => {
    const live = await liveSchema();
    for (const option of options(live)) {
      const kind = optionProps(option).kind.const as DeliveryControlKind;
      const body = optionProps(option).body;
      expect(body.required ?? [], kind).toEqual(requiredBodyFields[kind]);
    }
    const [decisionAnswer, overturn, steeringNote, roleChange, pause] = options(live);
    expect(Object.keys(optionProps(decisionAnswer).body.properties as JsonSchema)).toEqual([
      "option",
    ]);
    expect(Object.keys(optionProps(overturn).body.properties as JsonSchema)).toEqual([
      "option",
      "reason",
    ]);
    expect(Object.keys(optionProps(steeringNote).body.properties as JsonSchema)).toEqual([
      "note",
      "unit_ids",
    ]);
    expect(Object.keys(optionProps(roleChange).body.properties as JsonSchema)).toEqual(["tier"]);
    expect(Object.keys(optionProps(pause).body.properties as JsonSchema)).toEqual(["reason"]);
    const [modeSwitch, reviewAccept, threadMessage] = options(live).slice(8);
    const modeProps = optionProps(modeSwitch).body.properties as Record<string, JsonSchema>;
    expect(Object.keys(modeProps)).toEqual(["mode"]);
    expect(modeProps.mode.enum).toEqual(["attended", "auto"]);
    const acceptProps = optionProps(reviewAccept).body.properties as Record<string, JsonSchema>;
    expect(Object.keys(acceptProps)).toEqual(["summary"]);
    expect(acceptProps.summary.maxLength).toBe(DELIVERY_TEXT_MAX_LENGTH);
    const threadProps = optionProps(threadMessage).body.properties as Record<string, JsonSchema>;
    expect(Object.keys(threadProps)).toEqual(["text"]);
    expect(threadProps.text).toEqual({
      type: "string",
      minLength: 1,
      maxLength: DELIVERY_TEXT_MAX_LENGTH,
    });
  });
});

describe("delivery control contract: validation", () => {
  it("accepts a control of each of the eleven kinds with its own body", () => {
    expect(DELIVERY_CONTROL_KINDS).toHaveLength(11);
    expect(DeliveryControlSchema.options).toHaveLength(11);
    DELIVERY_CONTROL_KINDS.forEach((kind, index) => {
      const result = validateDeliveryControl(controlOf(kind, index + 1));
      expect(result, kind).toEqual(expect.objectContaining({ ok: true }));
      if (result.ok) {
        expect(result.data.kind).toBe(kind);
        expect(result.data.body).toEqual(bodies[kind]);
      }
    });
  });

  it("accepts a delivery-wide control with no target_id and an empty body", () => {
    for (const kind of ["pause", "wind-down", "resume"] as const) {
      const result = validateDeliveryControl({ ...controlOf(kind), body: {} });
      expect(result.ok, kind).toBe(true);
      if (result.ok) expect(result.data.target_id).toBeUndefined();
    }
  });

  it("requires every field but target_id, with a field-named error for each", () => {
    for (const option of DeliveryControlSchema.options) {
      expect(Object.keys(option.shape)).toEqual(FIELD_ORDER);
    }
    for (const key of REQUIRED_FIELDS) {
      const broken = Object.fromEntries(Object.entries(minimalControl).filter(([k]) => k !== key));
      const result = validateDeliveryControl(broken);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.startsWith(`${key}:`))).toBe(true);
    }
  });

  it("rejects a kind outside the eleven with an error at kind", () => {
    const result = validateDeliveryControl({ ...minimalControl, kind: "nudge" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        `kind: unknown control kind: expected one of ${ALL_KINDS.join(", ")}`,
      ]);
    }
  });

  it("SB-TC-098: mode_switch, review_accept and thread_message each validate and carry their durability", () => {
    const expected: Record<string, "durable" | "volatile"> = {
      mode_switch: "durable",
      review_accept: "durable",
      thread_message: "volatile",
    };
    for (const [kind, durability] of Object.entries(expected)) {
      const result = validateDeliveryControl(controlOf(kind as DeliveryControlKind));
      expect(result, kind).toEqual(expect.objectContaining({ ok: true }));
      if (result.ok) {
        expect(result.data.kind).toBe(kind);
        expect(result.data.durability).toBe(durability);
        expect(result.data.body).toEqual(bodies[kind as DeliveryControlKind]);
      }
      // The durability is pinned per kind: the other value fails at durability.
      const other = durability === "durable" ? "volatile" : "durable";
      const wrong = validateDeliveryControl({
        ...controlOf(kind as DeliveryControlKind),
        durability: other,
      });
      expect(wrong.ok, `${kind} as ${other}`).toBe(false);
      if (!wrong.ok) expect(wrong.errors).toEqual([expect.stringMatching(/^durability: /)]);
    }
    // Every control of the eight delivery kinds is durable.
    for (const kind of DELIVERY_CONTROL_KINDS.slice(0, 8)) {
      expect(DELIVERY_CONTROL_DURABILITY[kind], kind).toBe("durable");
    }
    const missing = Object.fromEntries(
      Object.entries(controlOf("thread_message")).filter(([k]) => k !== "durability"),
    );
    const result = validateDeliveryControl(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual([expect.stringMatching(/^durability: /)]);
  });

  it("SB-TC-098: a mode_switch names a mode, a thread_message a bounded non-empty text", () => {
    const cases: [DeliveryControlKind, Record<string, unknown>, string][] = [
      ["mode_switch", {}, "body.mode:"],
      ["mode_switch", { mode: "manual" }, "body.mode:"],
      ["thread_message", {}, "body.text:"],
      ["thread_message", { text: "" }, "body.text:"],
      ["thread_message", { text: "x".repeat(DELIVERY_TEXT_MAX_LENGTH + 1) }, "body.text:"],
      ["thread_message", { text: { rich: true } }, "body.text:"],
      ["review_accept", { summary: 7 }, "body.summary:"],
    ];
    for (const [kind, body, prefix] of cases) {
      const result = validateDeliveryControl({ ...controlOf(kind), body });
      expect(result.ok, `${kind} ${prefix}`).toBe(false);
      if (!result.ok) expect(result.errors).toEqual([expect.stringMatching(`^${prefix}`)]);
    }
    expect(
      validateDeliveryControl({
        ...controlOf("thread_message"),
        body: { text: "x".repeat(DELIVERY_TEXT_MAX_LENGTH) },
      }).ok,
    ).toBe(true);
    expect(
      validateDeliveryControl({ ...controlOf("mode_switch"), body: { mode: "auto" } }).ok,
    ).toBe(true);
  });

  it("lets an overturn target an agent decision with another option", () => {
    const result = validateDeliveryControl({
      ...controlOf("overturn"),
      target_id: "demo-decision-2",
      body: { option: "accept it", reason: "the fixtures will carry one" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.kind).toBe("overturn");
      expect(result.data.target_id).toBe("demo-decision-2");
      expect(result.data.durability).toBe("durable");
    }
  });

  it("defines the control read response: controls, latestSeq and an optional superseded list", () => {
    const controls = [controlOf("mode_switch", 3), controlOf("thread_message", 4)];
    const full = validateDeliveryControlReadResponse({
      controls,
      latestSeq: 4,
      superseded: [2],
    });
    expect(full).toEqual(expect.objectContaining({ ok: true }));
    if (full.ok) {
      expect(full.data.controls.map((c) => c.kind)).toEqual(["mode_switch", "thread_message"]);
      expect(full.data.latestSeq).toBe(4);
      expect(full.data.superseded).toEqual([2]);
    }
    const empty = validateDeliveryControlReadResponse({ controls: [], latestSeq: 0 });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.data.superseded).toBeUndefined();
    const cases: [Record<string, unknown>, string][] = [
      [{ latestSeq: 0 }, "controls:"],
      [{ controls: [] }, "latestSeq:"],
      [{ controls: [], latestSeq: -1 }, "latestSeq:"],
      [{ controls: [], latestSeq: 1, superseded: [0] }, "superseded.0:"],
      [{ controls: [{ ...controlOf("pause"), kind: "nudge" }], latestSeq: 1 }, "controls.0.kind:"],
    ];
    for (const [raw, prefix] of cases) {
      const result = validateDeliveryControlReadResponse(raw);
      expect(result.ok, prefix).toBe(false);
      if (!result.ok)
        expect(
          result.errors.some((e) => e.startsWith(prefix)),
          prefix,
        ).toBe(true);
    }
  });

  it("rejects a body that misses a required field of its kind, at body.<field>", () => {
    for (const kind of DELIVERY_CONTROL_KINDS) {
      for (const field of requiredBodyFields[kind]) {
        const body = Object.fromEntries(Object.entries(bodies[kind]).filter(([k]) => k !== field));
        const result = validateDeliveryControl({ ...controlOf(kind), body });
        expect(result.ok, `${kind} without ${field}`).toBe(false);
        if (!result.ok) {
          expect(result.errors).toEqual([expect.stringMatching(`^body\\.${field}: `)]);
        }
      }
    }
  });

  it("rejects a body of another kind: a kind with required body fields sees them missing", () => {
    const cases: [DeliveryControlKind, DeliveryControlKind, string[]][] = [
      ["decision-answer", "role-change", ["body.option"]],
      ["overturn", "steering-note", ["body.option"]],
      ["steering-note", "decision-answer", ["body.note", "body.unit_ids"]],
      ["role-change", "overturn", ["body.tier"]],
    ];
    for (const [kind, other, paths] of cases) {
      const result = validateDeliveryControl({ ...controlOf(kind), body: bodies[other] });
      expect(result.ok, `${kind} with the body of ${other}`).toBe(false);
      if (!result.ok) expect(result.errors.map((e) => e.split(":")[0])).toEqual(paths);
    }
  });

  it("rejects an empty option, note, tier or unit id and a non-string reason", () => {
    const cases: [DeliveryControlKind, Record<string, unknown>, string][] = [
      ["decision-answer", { option: "" }, "body.option:"],
      ["overturn", { option: "" }, "body.option:"],
      ["overturn", { option: "b", reason: 7 }, "body.reason:"],
      ["steering-note", { note: "", unit_ids: [] }, "body.note:"],
      ["steering-note", { note: "n", unit_ids: [""] }, "body.unit_ids.0:"],
      ["steering-note", { note: "n", unit_ids: "demo-unit-2" }, "body.unit_ids:"],
      ["role-change", { tier: "" }, "body.tier:"],
      ["pause", { reason: null }, "body.reason:"],
      ["approval", { reason: ["x"] }, "body.reason:"],
    ];
    for (const [kind, body, prefix] of cases) {
      const result = validateDeliveryControl({ ...controlOf(kind), body });
      expect(result.ok, `${kind} ${prefix}`).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.startsWith(prefix))).toBe(true);
    }
  });

  it("accepts the six statuses, in outbox order, and rejects any other at status", () => {
    expect(DELIVERY_CONTROL_STATUSES).toEqual(ALL_STATUSES);
    expect(DeliveryControlStatusSchema.options).toEqual(DELIVERY_CONTROL_STATUSES);
    for (const status of DELIVERY_CONTROL_STATUSES) {
      expect(validateDeliveryControl({ ...minimalControl, status }).ok, status).toBe(true);
    }
    for (const status of ["", "expired", "Pending", 1]) {
      const result = validateDeliveryControl({ ...minimalControl, status });
      expect(result.ok, String(status)).toBe(false);
      if (!result.ok) {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatch(/^status: /);
      }
    }
  });

  it("rejects a zero control_seq, a non-object body, a bad timestamp and an empty target_id", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...minimalControl, control_seq: 0 }, "control_seq:"],
      [{ ...minimalControl, control_seq: 1.5 }, "control_seq:"],
      [{ ...minimalControl, body: "text" }, "body:"],
      [{ ...minimalControl, issued_at: "soon" }, "issued_at:"],
      [{ ...minimalControl, target_id: "" }, "target_id:"],
    ];
    for (const [control, prefix] of cases) {
      const result = validateDeliveryControl(control);
      expect(result.ok, prefix).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.startsWith(prefix))).toBe(true);
    }
  });

  it("rejects a wrong $schema or schemaVersion", () => {
    const otherId = "https://roubo.dev/schema/delivery-event/v1.0.0.json";
    expect(validateDeliveryControl({ ...minimalControl, $schema: otherId }).ok).toBe(false);
    expect(validateDeliveryControl({ ...minimalControl, schemaVersion: "2.0.0" }).ok).toBe(false);
  });

  it("keeps an unknown key at the root and in the body (additive posture)", () => {
    const result = validateDeliveryControl({
      ...controlOf("role-change"),
      body: { tier: "fast", reason: "budget", nested: { deep: true } },
      applied_at: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.applied_at).toBeNull();
      expect(result.data.body).toEqual({ tier: "fast", reason: "budget", nested: { deep: true } });
    }
  });

  it.each([[null], [undefined], ["control"], [7], [[]]])(
    "rejects the non-object value %s",
    (value) => {
      expect(validateDeliveryControl(value).ok).toBe(false);
    },
  );
});

describe("delivery control contract: guards", () => {
  it("names no agent: the agent-identifier guard finds nothing in the contract source", () => {
    const findings = scanFiles([relative(repoRoot, SOURCE)], (f) =>
      readFileSync(join(repoRoot, f), "utf8"),
    );
    expect(findings).toEqual([]);
  });

  it("the agent-identifier guard still passes over server and shared", () => {
    const run = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts", "agent-identifier-guard.mjs")],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});

describe("delivery control contract: compatibility", () => {
  it("the committed baseline is the pinned published render", () => {
    const pin = publishedPin();
    expect(
      sha256(baselineBytes()),
      `the baseline of ${FILE} is not the pinned render of ${pin.version}: a baseline refresh publishes a version, so bump the contract version and re-pin version and sha256 in published.json`,
    ).toBe(pin.sha256);
    const [major, minor, patch] = pin.version.split(".").map(Number);
    expect(parseSchemaVersion(baselineSchema().$id)).toEqual({ major, minor, patch });
  });

  it("the live schema obeys the semver rule against its published baseline", async () => {
    const report = checkContractCompatibility(baselineSchema(), await liveSchema());
    expect(report.ok, `${report.message}\n${report.reasons.join("\n")}`).toBe(true);
    expect(report.message).toBe("no change at 1.0.0");
  });

  it("a twelfth kind, as a twelfth option on the root oneOf, is additive and needs a minor bump", () => {
    const baseline = baselineSchema();
    const template = options(baseline)[4];
    const ninth = {
      ...template,
      properties: { ...optionProps(template), kind: { type: "string", const: "nudge" } },
    };
    const grown = { ...baseline, oneOf: [...options(baseline), ninth] };
    expect(classifySchemaChange(baseline, grown)).toEqual({
      change: "additive",
      reasons: ['<root>: oneOf gained the option kind="nudge"'],
    });
    expect(checkContractCompatibility(baseline, grown).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(grown, "patch")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(grown, "minor")).ok).toBe(true);
    // The options are matched by kind, so the same ninth kind in the middle
    // of the oneOf is the same additive change, not a shift of the kinds after it.
    const inserted = {
      ...baseline,
      oneOf: [...options(baseline).slice(0, 4), ninth, ...options(baseline).slice(4)],
    };
    expect(classifySchemaChange(baseline, inserted)).toEqual(classifySchemaChange(baseline, grown));
  });

  it("a status gained or an optional body field added is additive and needs a minor bump", () => {
    const baseline = baselineSchema();
    const grown = {
      ...baseline,
      oneOf: options(baseline).map((option, index) => {
        const props = optionProps(option);
        const status = { ...props.status, enum: [...(props.status.enum as string[]), "expired"] };
        if (index !== 0) return { ...option, properties: { ...props, status } };
        const body = {
          ...props.body,
          properties: { ...(props.body.properties as JsonSchema), reason: { type: "string" } },
        };
        return { ...option, properties: { ...props, status, body } };
      }),
    };
    const report = classifySchemaChange(baseline, grown);
    expect(report.change).toBe("additive");
    expect(report.reasons).toContain(
      "<root>.oneOf.decision-answer.body.reason: new optional property",
    );
    expect(report.reasons).toContain("<root>.oneOf.decision-answer.status: enum gained a value");
    expect(report.reasons).toContain("<root>.oneOf.approval.status: enum gained a value");
    expect(checkContractCompatibility(baseline, grown).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(grown, "minor")).ok).toBe(true);
  });

  it("losing a kind, a status or requiring target_id is breaking and needs a major bump", () => {
    const baseline = baselineSchema();
    const lost = { ...baseline, oneOf: options(baseline).filter((_, i) => i !== 1) };
    expect(classifySchemaChange(baseline, lost)).toEqual({
      change: "breaking",
      reasons: ['<root>: oneOf lost the option kind="overturn"'],
    });
    expect(checkContractCompatibility(baseline, bumped(lost, "minor")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(lost, "major")).ok).toBe(true);

    const [first, ...rest] = options(baseline);
    const props = optionProps(first);
    const lostStatus = {
      ...baseline,
      oneOf: [
        {
          ...first,
          properties: {
            ...props,
            status: {
              ...props.status,
              enum: (props.status.enum as string[]).filter((s) => s !== "superseded"),
            },
          },
        },
        ...rest,
      ],
    };
    expect(classifySchemaChange(baseline, lostStatus)).toEqual({
      change: "breaking",
      reasons: ['<root>.oneOf.decision-answer.status: enum lost "superseded"'],
    });

    const nowRequired = {
      ...baseline,
      oneOf: [{ ...first, required: [...(first.required as string[]), "target_id"] }, ...rest],
    };
    expect(classifySchemaChange(baseline, nowRequired).change).toBe("breaking");
    expect(checkContractCompatibility(baseline, bumped(nowRequired, "major")).ok).toBe(true);
  });
});
