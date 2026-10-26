import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifacts, renderSchema, repoRoot } from "../scripts/generate-schema.js";
import {
  checkContractCompatibility,
  classifySchemaChange,
  parseSchemaVersion,
  type JsonSchema,
} from "../scripts/contract-compatibility.js";
import {
  DECISION_MODE_EVENT_TYPES,
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  DELIVERY_TEXT_MAX_LENGTH,
  DeliveryEventSchema,
  DeliveryGateSchema,
  DeliveryRecordSchema,
  validateDeliveryEvent,
  validateDeliveryRecord,
} from "./delivery-observation-contract.js";

const fixturePath = join(repoRoot, "shared", "__fixtures__", "delivery-record.json");
const baselineDir = join(repoRoot, "shared", "__fixtures__", "contract-baselines");

function loadFixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function artifactFor(name: string) {
  const artifact = artifacts.find((a) => a.outPath.endsWith(name));
  if (!artifact) throw new Error(`no generated artifact for ${name}`);
  return artifact;
}

async function liveSchema(name: string): Promise<JsonSchema> {
  const artifact = artifactFor(name);
  return JSON.parse(await renderSchema(artifact.schema, artifact.outPath));
}

// The committed baseline is the render of each contract at its last published
// version, and published.json pins that version and the sha256 of the baseline
// bytes. The gate below enforces three things: the baseline is still the pinned
// render (so a baseline cannot be refreshed in place to hide an edit: a refresh
// is a publication, which moves the pinned version and digest together), the
// baseline carries the pinned version, and the live render obeys the semver
// rule against it (no change: same version; additive: at least a minor bump;
// breaking: a major bump). To publish a version: regenerate schema/, copy the
// render over the baseline, and re-pin version and sha256 in published.json.
interface PublishedPin {
  version: string;
  sha256: string;
}

function publishedPin(name: string): PublishedPin {
  const pins: Record<string, PublishedPin> = JSON.parse(
    readFileSync(join(baselineDir, "published.json"), "utf8"),
  );
  const pin = pins[name];
  if (!pin) throw new Error(`published.json pins no baseline for ${name}`);
  return pin;
}

function baselineBytes(name: string): string {
  const file = name.replace(".schema.json", ".baseline.schema.json");
  return readFileSync(join(baselineDir, file), "utf8");
}

function baselineSchema(name: string): JsonSchema {
  return JSON.parse(baselineBytes(name));
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

function runGuard(script: string) {
  return spawnSync(process.execPath, [join(repoRoot, "scripts", script)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

const contracts = [
  {
    file: "delivery-record.schema.json",
    id: DELIVERY_RECORD_SCHEMA_ID,
    version: DELIVERY_RECORD_SCHEMA_VERSION,
    schema: DeliveryRecordSchema,
  },
  {
    file: "delivery-event.schema.json",
    id: DELIVERY_EVENT_SCHEMA_ID,
    version: DELIVERY_EVENT_SCHEMA_VERSION,
    schema: DeliveryEventSchema,
  },
];

const REQUIRED_SECTIONS = [
  "mode",
  "review",
  "units",
  "decisions",
  "steering",
  "budget",
  "roles",
  "health",
  "drift",
  "seams",
  "lifecycle",
  "last_event_seq",
];

const minimalEvent = {
  $schema: DELIVERY_EVENT_SCHEMA_ID,
  schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
  delivery_id: "demo-delivery-1",
  type: "unit.started",
  seq: 1,
  ts: "2026-10-16T09:00:00Z",
  unit_id: "A",
  payload: { branch: "demo/0-base" },
};

// One well-formed payload per decision-mode event type (SB-FR-040).
const decisionModePayloads: Record<string, Record<string, unknown>> = {
  "mode.changed": { value: "attended", pending: null, control_seq: 3 },
  "decision.decided": {
    decision_id: "decision-1",
    chosen: "one file per unit",
    author: "agent",
    rationale: "The default keeps the cache small.",
    affected_units: ["B"],
  },
  "review.opened": { trigger: "boundary", unreviewed: ["decision-2"] },
  "review.outcome": {
    decision_id: "decision-2",
    status: "accepted",
    reviewer: "Ada",
    summary: "Strict is right.",
    control_seq: 4,
  },
  "review.reply": {
    decision_id: "decision-2",
    text: "Why reject it?",
    author: "Ada",
    in_reply_to: "message-1",
  },
  "gate.provisional": {
    gate_id: "gate-after-b",
    cases: [
      { case: "DEMO-TC-001", mark: "met", evidence: "The suite row passed.", confirmed: false },
      { case: "DEMO-TC-002", mark: "not_met", evidence: "No suite row names it." },
    ],
  },
  "gate.confirmed": { gate_id: "gate-after-c", cases: ["DEMO-TC-003"], control_seq: 5 },
};

function decisionModeEvent(
  type: string,
  payload: Record<string, unknown> = decisionModePayloads[type],
) {
  return { ...minimalEvent, type, payload };
}

describe("delivery observation contract: generated schema", () => {
  it.each(contracts)(
    "SB-TC-010: $file is zod in shared with a versioned $id and its committed JSON equals a fresh render",
    async ({ file, id, version, schema }) => {
      // The zod source carries the $id, and the id embeds the version: the
      // record at 1.1.0 (the drift and per-role cost fields), the event
      // envelope still at 1.0.0.
      expect(version).toBe(file === "delivery-record.schema.json" ? "1.1.0" : "1.0.0");
      expect(id.endsWith(`/v${version}.json`)).toBe(true);
      expect(schema.meta()?.$id).toBe(id);

      // The generator lists it, and the committed artifact under schema/ is
      // byte-equal to a fresh render, which is what the CI drift gate checks.
      const artifact = artifactFor(file);
      const rendered = await renderSchema(artifact.schema, artifact.outPath);
      expect(readFileSync(artifact.outPath, "utf8")).toBe(rendered);
      expect(JSON.parse(rendered).$id).toBe(id);
    },
  );

  it("SB-TC-010: the record and event $schema constants match their $id", async () => {
    for (const { file, id, version } of contracts) {
      const live = await liveSchema(file);
      const props = live.properties as Record<string, JsonSchema>;
      expect(props.$schema.const).toBe(id);
      expect(props.schemaVersion.const).toBe(version);
    }
  });
});

describe("delivery observation contract: record fixture", () => {
  it("SB-TC-011: the conformant record fixture validates against the record schema", () => {
    const result = validateDeliveryRecord(loadFixture());
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.data.schemaVersion).toBe(DELIVERY_RECORD_SCHEMA_VERSION);
      expect(result.data.units.map((u) => u.id)).toEqual(["A", "B", "C", "D"]);
      expect(result.data.stack.stacks.A).toEqual(["A", "B", "C"]);
      expect(result.data.stack.gates.map((g) => g.after)).toEqual([["B"], ["C"]]);
    }
  });

  it("SB-TC-011: the record carries every required section under a neutral name", () => {
    const keys = Object.keys(loadFixture());
    for (const key of REQUIRED_SECTIONS) {
      expect(keys).toContain(key);
    }
    // The schema requires the same sections: dropping one fails validation.
    expect(Object.keys(DeliveryRecordSchema.shape)).toEqual(
      expect.arrayContaining(REQUIRED_SECTIONS),
    );
    for (const key of REQUIRED_SECTIONS) {
      const broken = Object.fromEntries(Object.entries(loadFixture()).filter(([k]) => k !== key));
      const result = validateDeliveryRecord(broken);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.startsWith(`${key}:`))).toBe(true);
    }
  });

  it("SB-TC-022: a unit entry carries an optional pull request url, a string when present", () => {
    const fixture = loadFixture();
    const units = fixture.units as Record<string, unknown>[];
    const withUrl = validateDeliveryRecord({
      ...fixture,
      units: [{ ...units[0], pr_url: "https://github.com/demo/demo/pull/1" }, ...units.slice(1)],
    });
    expect(withUrl.ok).toBe(true);
    if (withUrl.ok) {
      expect(withUrl.data.units[0].pr_url).toBe("https://github.com/demo/demo/pull/1");
    }

    const notString = validateDeliveryRecord({
      ...fixture,
      units: [{ ...units[0], pr_url: 1 }, ...units.slice(1)],
    });
    expect(notString.ok).toBe(false);
    if (!notString.ok) {
      expect(notString.errors.some((e) => e.startsWith("units.0.pr_url"))).toBe(true);
    }
  });

  it("SB-TC-048: a drift entry carries an optional file, summary, minted ids and spec-layer pull request", () => {
    const fixture = loadFixture();
    const edit = {
      kind: "spec",
      detail: "Added a case for the stale indicator",
      detected_at: "2026-10-16T09:25:00Z",
      file: "test-cases.json",
      summary: "Added a case for the stale indicator",
      ids: ["DEMO-TC-004", "DEMO-FR-002"],
      pr_url: "https://github.com/demo/demo/pull/7",
    };
    const withEdit = validateDeliveryRecord({ ...fixture, drift: [edit] });
    expect(withEdit.ok).toBe(true);
    if (withEdit.ok) expect(withEdit.data.drift[0]).toEqual(edit);

    for (const [field, value] of [
      ["file", ""],
      ["summary", ""],
      ["ids", [""]],
      ["pr_url", 7],
    ] as const) {
      const broken = validateDeliveryRecord({ ...fixture, drift: [{ ...edit, [field]: value }] });
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.errors.some((e) => e.startsWith(`drift.0.${field}`))).toBe(true);
    }
  });

  it("SB-TC-046: the budget carries an optional per-role cost map of non-negative numbers", () => {
    const fixture = loadFixture();
    const budget = fixture.budget as Record<string, unknown>;
    const withRoles = validateDeliveryRecord({
      ...fixture,
      budget: { ...budget, by_role: { main: 0.1, "unit-coder": 0.32 } },
    });
    expect(withRoles.ok).toBe(true);
    if (withRoles.ok) expect(withRoles.data.budget.by_role).toEqual({ main: 0.1, "unit-coder": 0.32 });

    const negative = validateDeliveryRecord({
      ...fixture,
      budget: { ...budget, by_role: { main: -1 } },
    });
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.errors.some((e) => e.startsWith("budget.by_role.main"))).toBe(true);
    }
  });

  it("a seam entry carries an optional unit id, a non-empty string when present", () => {
    const fixture = loadFixture();
    const seams = fixture.seams as Record<string, Record<string, unknown>>;
    const withUnit = validateDeliveryRecord({
      ...fixture,
      seams: { ...seams, compaction: { status: "ok", unit_id: "B" } },
    });
    expect(withUnit.ok).toBe(true);
    if (withUnit.ok) expect(withUnit.data.seams.compaction.unit_id).toBe("B");

    const empty = validateDeliveryRecord({
      ...fixture,
      seams: { ...seams, compaction: { status: "ok", unit_id: "" } },
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors.some((e) => e.startsWith("seams.compaction.unit_id"))).toBe(true);
    }
  });

  it("keeps an unknown key at the root and inside a section (additive posture)", () => {
    const fixture = loadFixture();
    const record = {
      ...fixture,
      notes: "free text",
      review: { ...(fixture.review as object), opened_at: "2026-10-16T09:31:00Z" },
      lifecycle: { ...(fixture.lifecycle as object), paused_at: null },
    };
    const result = validateDeliveryRecord(record);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.notes).toBe("free text");
      expect(result.data.review.opened_at).toBe("2026-10-16T09:31:00Z");
      expect(result.data.lifecycle.paused_at).toBeNull();
    }
  });

  it("SB-TC-098: the fixture carries the mode, the review section, the decision review fields and a provisional gate", () => {
    const result = validateDeliveryRecord(loadFixture());
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (!result.ok) return;
    expect(result.data.schemaVersion).toBe(DELIVERY_RECORD_SCHEMA_VERSION);
    expect(result.data.mode).toEqual({ value: "auto", pending: null });
    expect(result.data.review).toEqual({ status: "pending", unreviewed: ["decision-2"] });
    const decided = result.data.decisions[1];
    expect(decided.author).toBe("agent");
    expect(decided.chosen).toBe("reject it");
    expect(decided.rationale).toMatch(/strict/);
    expect(decided.affected_units).toEqual(["B", "C"]);
    expect(decided.review).toEqual({ status: "unreviewed" });
    // The status word is the one key of the provisional state: the fixture
    // carries no separate flag, and the schema knows none.
    const gate = result.data.stack.gates[1];
    expect(gate.status).toBe("provisional");
    expect(Object.keys(gate)).not.toContain("provisional");
    expect(Object.keys(DeliveryGateSchema.shape)).not.toContain("provisional");
    expect(gate.provisionalCases).toEqual([
      {
        case: "DEMO-TC-003",
        mark: "met",
        evidence: expect.any(String),
        confirmed: false,
      },
    ]);
  });

  it("SB-TC-098: the fixture with the mode section removed fails with a conformance error that names the section", () => {
    const withoutMode = Object.fromEntries(
      Object.entries(loadFixture()).filter(([key]) => key !== "mode"),
    );
    const result = validateDeliveryRecord(withoutMode);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^mode: /);
    }
  });

  it("rejects a mode value, a review status, a decision review status or a mark outside its vocabulary", () => {
    const fixture = loadFixture();
    const decisions = fixture.decisions as Record<string, unknown>[];
    const stack = fixture.stack as { stacks: unknown; gates: Record<string, unknown>[] };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...fixture, mode: { value: "manual" } }, "mode.value:"],
      [{ ...fixture, mode: { value: "auto", pending: "manual" } }, "mode.pending:"],
      [{ ...fixture, review: { status: "closed", unreviewed: [] } }, "review.status:"],
      [
        { ...fixture, decisions: [decisions[0], { ...decisions[1], review: { status: "seen" } }] },
        "decisions.1.review.status:",
      ],
      [
        {
          ...fixture,
          stack: {
            ...stack,
            gates: [
              stack.gates[0],
              {
                ...stack.gates[1],
                provisionalCases: [
                  { case: "DEMO-TC-003", mark: "passed", evidence: "", confirmed: false },
                ],
              },
            ],
          },
        },
        "stack.gates.1.provisionalCases.0.mark:",
      ],
    ];
    for (const [record, prefix] of cases) {
      const result = validateDeliveryRecord(record);
      expect(result.ok, prefix).toBe(false);
      if (!result.ok)
        expect(
          result.errors.some((e) => e.startsWith(prefix)),
          prefix,
        ).toBe(true);
    }
  });

  it("rejects a chosen option outside the decision's options and an unreviewed id the record does not carry", () => {
    const fixture = loadFixture();
    const decisions = fixture.decisions as Record<string, unknown>[];
    const badChosen = validateDeliveryRecord({
      ...fixture,
      decisions: [decisions[0], { ...decisions[1], chosen: "ignore it" }],
    });
    expect(badChosen.ok).toBe(false);
    if (!badChosen.ok) {
      expect(badChosen.errors).toContain(
        "decisions.1.chosen: must be one of the decision's options",
      );
    }
    const badUnreviewed = validateDeliveryRecord({
      ...fixture,
      review: { status: "pending", unreviewed: ["decision-9"] },
    });
    expect(badUnreviewed.ok).toBe(false);
    if (!badUnreviewed.ok) {
      expect(badUnreviewed.errors).toContain(
        "review.unreviewed.0: names a decision the record does not carry",
      );
    }
  });

  it("bounds every session-authored text: a rationale, a summary or an evidence over the limit fails at its field", () => {
    const fixture = loadFixture();
    const decisions = fixture.decisions as Record<string, unknown>[];
    const stack = fixture.stack as { stacks: unknown; gates: Record<string, unknown>[] };
    const tooLong = "x".repeat(DELIVERY_TEXT_MAX_LENGTH + 1);
    const atLimit = "x".repeat(DELIVERY_TEXT_MAX_LENGTH);
    expect(
      validateDeliveryRecord({
        ...fixture,
        decisions: [decisions[0], { ...decisions[1], rationale: atLimit }],
      }).ok,
    ).toBe(true);
    const cases: [Record<string, unknown>, string][] = [
      [
        { ...fixture, decisions: [decisions[0], { ...decisions[1], rationale: tooLong }] },
        "decisions.1.rationale:",
      ],
      [
        {
          ...fixture,
          decisions: [
            decisions[0],
            { ...decisions[1], review: { status: "accepted", summary: tooLong } },
          ],
        },
        "decisions.1.review.summary:",
      ],
      [
        {
          ...fixture,
          stack: {
            ...stack,
            gates: [
              stack.gates[0],
              {
                ...stack.gates[1],
                provisionalCases: [
                  { case: "DEMO-TC-003", mark: "met", evidence: tooLong, confirmed: false },
                ],
              },
            ],
          },
        },
        "stack.gates.1.provisionalCases.0.evidence:",
      ],
      [
        { ...fixture, decisions: [decisions[0], { ...decisions[1], rationale: ["x"] }] },
        "decisions.1.rationale:",
      ],
    ];
    for (const [record, prefix] of cases) {
      const result = validateDeliveryRecord(record);
      expect(result.ok, prefix).toBe(false);
      if (!result.ok)
        expect(
          result.errors.some((e) => e.startsWith(prefix)),
          prefix,
        ).toBe(true);
    }
  });

  it("bounds a decision's question, options, default, chosen and author, a reviewer and a review trigger the same way", () => {
    const fixture = loadFixture();
    const decisions = fixture.decisions as Record<string, unknown>[];
    const tooLong = "x".repeat(DELIVERY_TEXT_MAX_LENGTH + 1);
    const atLimit = "x".repeat(DELIVERY_TEXT_MAX_LENGTH);
    // At the limit every one of them passes.
    expect(
      validateDeliveryRecord({
        ...fixture,
        review: { status: "open", trigger: atLimit, unreviewed: ["decision-2"] },
        decisions: [
          decisions[0],
          {
            ...decisions[1],
            question: atLimit,
            options: ["accept it", atLimit],
            default: atLimit,
            chosen: atLimit,
            author: atLimit,
            review: { status: "accepted", reviewer: atLimit },
          },
        ],
      }).ok,
    ).toBe(true);
    const decided = (patch: Record<string, unknown>) => ({
      ...fixture,
      decisions: [decisions[0], { ...decisions[1], ...patch }],
    });
    const cases: [Record<string, unknown>, string][] = [
      [decided({ question: tooLong }), "decisions.1.question:"],
      [decided({ options: ["accept it", "reject it", tooLong] }), "decisions.1.options.2:"],
      [decided({ options: ["reject it", tooLong], default: tooLong }), "decisions.1.default:"],
      [decided({ options: ["reject it", tooLong], chosen: tooLong }), "decisions.1.chosen:"],
      [decided({ author: tooLong }), "decisions.1.author:"],
      [
        decided({ review: { status: "accepted", reviewer: tooLong } }),
        "decisions.1.review.reviewer:",
      ],
      [
        { ...fixture, review: { status: "open", trigger: tooLong, unreviewed: ["decision-2"] } },
        "review.trigger:",
      ],
    ];
    for (const [record, prefix] of cases) {
      const result = validateDeliveryRecord(record);
      expect(result.ok, prefix).toBe(false);
      if (!result.ok)
        expect(
          result.errors.some((e) => e.startsWith(prefix)),
          prefix,
        ).toBe(true);
    }
  });

  it("rejects a wrong $schema or schemaVersion", () => {
    const fixture = loadFixture();
    const otherId = "https://roubo.dev/schema/other/v1.0.0.json";
    expect(validateDeliveryRecord({ ...fixture, $schema: otherId }).ok).toBe(false);
    expect(validateDeliveryRecord({ ...fixture, schemaVersion: "2.0.0" }).ok).toBe(false);
  });

  it("rejects a decision whose default is not one of its options", () => {
    const fixture = loadFixture();
    const decisions = fixture.decisions as Record<string, unknown>[];
    const result = validateDeliveryRecord({
      ...fixture,
      decisions: [{ ...decisions[0], default: "a third option" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("decisions.0.default: must be one of the decision's options");
    }
  });

  it("rejects a stack or a gate that names a unit the record does not carry", () => {
    const fixture = loadFixture();
    const stack = fixture.stack as {
      stacks: Record<string, string[]>;
      gates: Record<string, unknown>[];
    };
    const badStack = validateDeliveryRecord({
      ...fixture,
      stack: { ...stack, stacks: { ...stack.stacks, A: ["A", "B", "C", "E"] } },
    });
    expect(badStack.ok).toBe(false);
    if (!badStack.ok) {
      expect(badStack.errors).toContain("stack.stacks.A.3: names a unit the record does not carry");
    }

    const badGate = validateDeliveryRecord({
      ...fixture,
      stack: { ...stack, gates: [{ ...stack.gates[0], after: ["E"] }] },
    });
    expect(badGate.ok).toBe(false);
    if (!badGate.ok) {
      expect(badGate.errors).toContain(
        "stack.gates.0.after.0: names a unit the record does not carry",
      );
    }
  });

  it("rejects a unit placed on a stack the record does not carry", () => {
    const fixture = loadFixture();
    const units = fixture.units as Record<string, unknown>[];
    const result = validateDeliveryRecord({
      ...fixture,
      units: [...units.slice(0, 3), { ...units[3], stack: "E" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("units.3.stack: names a stack the record does not carry");
    }
  });

  it("rejects a malformed timestamp with a field-named error", () => {
    const result = validateDeliveryRecord({ ...loadFixture(), updated_at: "yesterday" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith("updated_at:"))).toBe(true);
  });
});

describe("delivery observation contract: event envelope", () => {
  it("accepts an envelope with an open payload and an optional unit_id", () => {
    expect(validateDeliveryEvent(minimalEvent).ok).toBe(true);
    const deliveryWide = {
      $schema: DELIVERY_EVENT_SCHEMA_ID,
      schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
      delivery_id: "demo-delivery-1",
      type: "delivery.armed",
      seq: 2,
      ts: "2026-10-16T09:00:01Z",
      payload: {},
    };
    const result = validateDeliveryEvent(deliveryWide);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.unit_id).toBeUndefined();
  });

  it("accepts any event type outside the decision-mode seven with any payload keys (open payload decision for 1.0.0)", () => {
    for (const type of ["unit.done", "gate.changed", "decision.raised", "steering.added"]) {
      const result = validateDeliveryEvent({
        ...minimalEvent,
        type,
        payload: { anything: [1, 2, 3], nested: { deep: true } },
      });
      expect(result.ok).toBe(true);
    }
  });

  it("SB-TC-098: one fixture event of each of the seven decision-mode types validates", () => {
    expect(DECISION_MODE_EVENT_TYPES).toEqual([
      "mode.changed",
      "decision.decided",
      "review.opened",
      "review.outcome",
      "review.reply",
      "gate.provisional",
      "gate.confirmed",
    ]);
    expect(Object.keys(decisionModePayloads)).toEqual(DECISION_MODE_EVENT_TYPES);
    for (const type of DECISION_MODE_EVENT_TYPES) {
      const result = validateDeliveryEvent(decisionModeEvent(type));
      expect(result, type).toEqual(expect.objectContaining({ ok: true }));
      if (result.ok) {
        expect(result.data.type).toBe(type);
        expect(result.data.payload).toEqual(decisionModePayloads[type]);
      }
    }
  });

  it("keeps an unknown payload key on a decision-mode event (additive posture)", () => {
    const result = validateDeliveryEvent(
      decisionModeEvent("mode.changed", { value: "auto", reason: "budget", nested: { a: 1 } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.payload.reason).toBe("budget");
  });

  it("a read-back event carries control_seq or in_reply_to: a review.reply with neither fails at payload.in_reply_to", () => {
    const withControl = decisionModeEvent("review.reply", {
      decision_id: "decision-2",
      text: "Because the grammar is strict.",
      control_seq: 7,
    });
    expect(validateDeliveryEvent(withControl).ok).toBe(true);
    const neither = decisionModeEvent("review.reply", {
      decision_id: "decision-2",
      text: "Because the grammar is strict.",
    });
    const result = validateDeliveryEvent(neither);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([expect.stringMatching(/^payload\.in_reply_to: /)]);
    }
    const badSeq = decisionModeEvent("mode.changed", { value: "auto", control_seq: 0 });
    const seqResult = validateDeliveryEvent(badSeq);
    expect(seqResult.ok).toBe(false);
    if (!seqResult.ok) {
      expect(seqResult.errors.some((e) => e.startsWith("payload.control_seq:"))).toBe(true);
    }
  });

  it("bounds every session-authored payload string: an over-long question, option, chosen, author, reviewer or trigger fails at its field", () => {
    const tooLong = "x".repeat(DELIVERY_TEXT_MAX_LENGTH + 1);
    const atLimit = "x".repeat(DELIVERY_TEXT_MAX_LENGTH);
    expect(
      validateDeliveryEvent(
        decisionModeEvent("decision.decided", {
          decision_id: "decision-9",
          question: atLimit,
          options: [atLimit, "other"],
          default: atLimit,
          chosen: atLimit,
          author: atLimit,
        }),
      ).ok,
    ).toBe(true);
    const cases: [string, Record<string, unknown>, string][] = [
      [
        "decision.decided",
        {
          decision_id: "decision-9",
          chosen: "a",
          question: tooLong,
          options: ["a", "b"],
          default: "a",
        },
        "payload.question:",
      ],
      [
        "decision.decided",
        {
          decision_id: "decision-9",
          chosen: "a",
          question: "q",
          options: ["a", tooLong],
          default: "a",
        },
        "payload.options.1:",
      ],
      [
        "decision.decided",
        {
          decision_id: "decision-9",
          chosen: "a",
          question: "q",
          options: ["a", "b"],
          default: tooLong,
        },
        "payload.default:",
      ],
      ["decision.decided", { decision_id: "decision-1", chosen: tooLong }, "payload.chosen:"],
      [
        "decision.decided",
        { decision_id: "decision-1", chosen: "one file per unit", author: tooLong },
        "payload.author:",
      ],
      ["review.opened", { trigger: tooLong }, "payload.trigger:"],
      [
        "review.outcome",
        { decision_id: "decision-2", status: "accepted", reviewer: tooLong },
        "payload.reviewer:",
      ],
      [
        "review.outcome",
        { decision_id: "decision-2", status: "overturned", chosen: tooLong },
        "payload.chosen:",
      ],
      [
        "review.reply",
        { decision_id: "decision-2", text: "Why?", author: tooLong, control_seq: 1 },
        "payload.author:",
      ],
    ];
    for (const [type, payload, prefix] of cases) {
      const result = validateDeliveryEvent(decisionModeEvent(type, payload));
      expect(result.ok, `${type} ${prefix}`).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.startsWith(prefix)),
          `${type} ${prefix}`,
        ).toBe(true);
      }
    }
  });

  it("SB-TC-099: a review.outcome with no decision id is rejected with an error that names payload.decision_id", () => {
    const payload = Object.fromEntries(
      Object.entries(decisionModePayloads["review.outcome"]).filter(
        ([key]) => key !== "decision_id",
      ),
    );
    const result = validateDeliveryEvent(decisionModeEvent("review.outcome", payload));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([expect.stringMatching(/^payload\.decision_id: /)]);
    }
  });

  it("SB-TC-099: a gate.provisional with a mark outside met and not_met is rejected with an error that names the field", () => {
    const result = validateDeliveryEvent(
      decisionModeEvent("gate.provisional", {
        gate_id: "gate-after-b",
        cases: [{ case: "DEMO-TC-001", mark: "passed", evidence: "" }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([expect.stringMatching(/^payload\.cases\.0\.mark: /)]);
    }
  });

  it("SB-TC-099: each decision-mode event misses its required payload field with an error that names it", () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["mode.changed", { pending: "auto" }, "payload.value:"],
      ["mode.changed", { value: "manual" }, "payload.value:"],
      ["decision.decided", { chosen: "one file per unit" }, "payload.decision_id:"],
      ["decision.decided", { decision_id: "decision-1" }, "payload.chosen:"],
      [
        "decision.decided",
        { decision_id: "decision-1", chosen: "a", rationale: 7 },
        "payload.rationale:",
      ],
      ["review.opened", { unreviewed: "decision-2" }, "payload.unreviewed:"],
      ["review.outcome", { decision_id: "decision-2" }, "payload.status:"],
      ["review.outcome", { decision_id: "decision-2", status: "unreviewed" }, "payload.status:"],
      ["review.reply", { decision_id: "decision-2", in_reply_to: "m" }, "payload.text:"],
      ["review.reply", { decision_id: "decision-2", text: "", in_reply_to: "m" }, "payload.text:"],
      [
        "review.reply",
        {
          decision_id: "decision-2",
          text: "x".repeat(DELIVERY_TEXT_MAX_LENGTH + 1),
          in_reply_to: "m",
        },
        "payload.text:",
      ],
      ["gate.provisional", { cases: [] }, "payload.gate_id:"],
      ["gate.provisional", { gate_id: "gate-after-b" }, "payload.cases:"],
      [
        "gate.provisional",
        { gate_id: "gate-after-b", cases: [{ mark: "met" }] },
        "payload.cases.0.case:",
      ],
      ["gate.confirmed", { cases: ["DEMO-TC-003"] }, "payload.gate_id:"],
      ["gate.confirmed", { gate_id: "gate-after-c", cases: [""] }, "payload.cases.0:"],
    ];
    for (const [type, payload, prefix] of cases) {
      const result = validateDeliveryEvent(decisionModeEvent(type, payload));
      expect(result.ok, `${type} ${prefix}`).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) => e.startsWith(prefix)),
          `${type} ${prefix}`,
        ).toBe(true);
      }
    }
  });

  it("rejects a zero seq, an empty type, a non-object payload and a bad timestamp", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...minimalEvent, seq: 0 }, "seq:"],
      [{ ...minimalEvent, type: "" }, "type:"],
      [{ ...minimalEvent, payload: "text" }, "payload:"],
      [{ ...minimalEvent, ts: "soon" }, "ts:"],
    ];
    for (const [event, prefix] of cases) {
      const result = validateDeliveryEvent(event);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.startsWith(prefix))).toBe(true);
    }
  });

  it.each([[null], [undefined], ["event"], [7], [[]]])(
    "rejects the non-object value %s",
    (value) => {
      expect(validateDeliveryEvent(value).ok).toBe(false);
      expect(validateDeliveryRecord(value).ok).toBe(false);
    },
  );
});

describe("delivery observation contract: guards", () => {
  it("SB-TC-017: the agent-identifier guard reports zero matches over server and shared", () => {
    const run = runGuard("agent-identifier-guard.mjs");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("SB-TC-098: the agent-identifier guard passes over server and shared with the decision-mode fields in place", () => {
    const run = runGuard("agent-identifier-guard.mjs");
    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/No agent-specific-knowledge violations found/);
    expect(run.status).toBe(0);
  });

  it("SB-TC-098: the schema generator produces no difference against the committed delivery schema files", async () => {
    for (const file of [
      "delivery-record.schema.json",
      "delivery-event.schema.json",
      "delivery-control.schema.json",
      "delivery-control-read-response.schema.json",
    ]) {
      const artifact = artifactFor(file);
      const rendered = await renderSchema(artifact.schema, artifact.outPath);
      expect(readFileSync(artifact.outPath, "utf8"), file).toBe(rendered);
    }
    // The rendered record schema carries the decision-mode fields.
    const record = await liveSchema("delivery-record.schema.json");
    const props = record.properties as Record<string, JsonSchema>;
    expect(record.required).toEqual(expect.arrayContaining(["mode", "review"]));
    expect((props.mode.properties as Record<string, JsonSchema>).value.enum).toEqual([
      "attended",
      "auto",
    ]);
    expect((props.review.properties as Record<string, JsonSchema>).status.enum).toEqual([
      "none",
      "pending",
      "open",
    ]);
    const decision = (props.decisions.items as JsonSchema).properties as Record<string, JsonSchema>;
    expect(Object.keys(decision)).toEqual(
      expect.arrayContaining(["author", "chosen", "rationale", "affected_units", "review"]),
    );
    expect(decision.rationale.maxLength).toBe(DELIVERY_TEXT_MAX_LENGTH);
    expect(decision.question.maxLength).toBe(DELIVERY_TEXT_MAX_LENGTH);
    expect(decision.chosen.maxLength).toBe(DELIVERY_TEXT_MAX_LENGTH);
    const stackProps = props.stack.properties as Record<string, JsonSchema>;
    const gate = (stackProps.gates.items as JsonSchema).properties as Record<string, JsonSchema>;
    // The status word carries the provisional state: no separate flag is rendered.
    expect(Object.keys(gate)).toEqual(expect.arrayContaining(["status", "provisionalCases"]));
    expect(Object.keys(gate)).not.toContain("provisional");
    const provisionalCase = (gate.provisionalCases.items as JsonSchema).properties as Record<
      string,
      JsonSchema
    >;
    expect(provisionalCase.mark.enum).toEqual(["met", "not_met"]);
    expect(provisionalCase.evidence.maxLength).toBe(DELIVERY_TEXT_MAX_LENGTH);
  });

  it("SB-TC-017: the repository-reference guard passes over every tracked file", () => {
    const run = runGuard("repo-reference-guard.mjs");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});

describe("delivery observation contract: compatibility", () => {
  it.each(contracts)(
    "SB-TC-019: the committed baseline of $file is the pinned published render",
    ({ file }) => {
      const pin = publishedPin(file);
      const digest = sha256(baselineBytes(file));
      // A baseline refreshed in place without a publication fails here: the
      // pin still names the old bytes. Publishing re-pins version and digest.
      expect(
        digest,
        `the baseline of ${file} is not the pinned render of ${pin.version}: a baseline refresh publishes a version, so bump the contract version and re-pin version and sha256 in published.json`,
      ).toBe(pin.sha256);
      const [major, minor, patch] = pin.version.split(".").map(Number);
      expect(parseSchemaVersion(baselineSchema(file).$id)).toEqual({ major, minor, patch });
    },
  );

  it.each(contracts)(
    "SB-TC-019: the live $file obeys the semver rule against its published baseline",
    async ({ file }) => {
      // `ok` is the version rule: an unchanged shape holds the version, an
      // additive one has bumped the minor, a breaking one the major. A correctly
      // versioned change passes; an unversioned one fails with the step it needs.
      const report = checkContractCompatibility(baselineSchema(file), await liveSchema(file));
      expect(report.ok, `${report.message}\n${report.reasons.join("\n")}`).toBe(true);
    },
  );

  // The edits below start from the published baseline, not the live render, so
  // they hold while a new version is in flight (live already differs then).
  it("SB-TC-019: adding an optional field to the record passes once the minor is bumped", () => {
    const baseline = baselineSchema("delivery-record.schema.json");
    const added = {
      ...baseline,
      properties: { ...(baseline.properties as JsonSchema), notes: { type: "string" } },
    };
    expect(classifySchemaChange(baseline, added)).toEqual({
      change: "additive",
      reasons: ["notes: new optional property"],
    });
    // Same version, or a patch bump: the test fails until the minor moves.
    const same = checkContractCompatibility(baseline, added);
    expect(same.ok).toBe(false);
    expect(same.message).toMatch(/at least a minor bump/);
    expect(checkContractCompatibility(baseline, bumped(added, "patch")).ok).toBe(false);
    // Minor bump: the test passes.
    const minor = checkContractCompatibility(baseline, bumped(added, "minor"));
    expect(minor.ok).toBe(true);
    expect(minor.change).toBe("additive");
  });

  it("SB-TC-019: removing a required record field fails until the major is bumped", () => {
    const baseline = baselineSchema("delivery-record.schema.json");
    const props = { ...(baseline.properties as JsonSchema) };
    delete props.seams;
    const removed = {
      ...baseline,
      properties: props,
      required: (baseline.required as string[]).filter((k) => k !== "seams"),
    };
    expect(classifySchemaChange(baseline, removed)).toEqual({
      change: "breaking",
      reasons: ["seams: property removed"],
    });
    expect(checkContractCompatibility(baseline, removed).ok).toBe(false);
    const minor = checkContractCompatibility(baseline, bumped(removed, "minor"));
    expect(minor.ok).toBe(false);
    expect(minor.message).toMatch(/needs a major bump/);
    const major = checkContractCompatibility(baseline, bumped(removed, "major"));
    expect(major.ok).toBe(true);
    expect(major.change).toBe("breaking");
  });

  it("SB-TC-019: requiring an optional envelope field is breaking, a new optional one is additive", () => {
    const baseline = baselineSchema("delivery-event.schema.json");
    const required = baseline.required as string[];
    const nowRequired = { ...baseline, required: [...required, "unit_id"] };
    expect(classifySchemaChange(baseline, nowRequired).change).toBe("breaking");
    expect(checkContractCompatibility(baseline, bumped(nowRequired, "minor")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(nowRequired, "major")).ok).toBe(true);

    const withActor = {
      ...baseline,
      properties: { ...(baseline.properties as JsonSchema), actor: { type: "string" } },
    };
    expect(checkContractCompatibility(baseline, bumped(withActor, "patch")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(withActor, "minor")).ok).toBe(true);
  });
});
