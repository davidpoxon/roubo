import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifacts, renderSchema, repoRoot } from "../scripts/generate-schema.js";
import {
  checkContractCompatibility,
  classifySchemaChange,
  type JsonSchema,
} from "../scripts/contract-compatibility.js";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  DeliveryEventSchema,
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

// The committed baseline is the last published shape of each contract. It is
// refreshed by hand when a version ships, which is what lets the suite tell an
// unversioned edit from a released one.
function baselineSchema(name: string): JsonSchema {
  const file = name.replace(".schema.json", ".baseline.schema.json");
  return JSON.parse(readFileSync(join(baselineDir, file), "utf8"));
}

function withId(schema: JsonSchema, version: string): JsonSchema {
  const id = String(schema.$id).replace(/v\d+\.\d+\.\d+\.json$/, `v${version}.json`);
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

describe("delivery observation contract: generated schema", () => {
  it.each(contracts)(
    "SB-TC-010: $file is zod in shared with a versioned $id at 1.0.0 and its committed JSON equals a fresh render",
    async ({ file, id, version, schema }) => {
      // The zod source carries the $id, and the id embeds the 1.0.0 version.
      expect(version).toBe("1.0.0");
      expect(id).toMatch(/\/v1\.0\.0\.json$/);
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
  it("SB-TC-011: the conformant 1.0.0 record fixture validates against the record schema", () => {
    const result = validateDeliveryRecord(loadFixture());
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.data.schemaVersion).toBe("1.0.0");
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

  it("keeps an unknown key at the root and inside a section (additive posture)", () => {
    const fixture = loadFixture();
    const record = {
      ...fixture,
      mode: "auto",
      review: { status: "pending" },
      lifecycle: { ...(fixture.lifecycle as object), paused_at: null },
    };
    const result = validateDeliveryRecord(record);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.mode).toBe("auto");
      expect(result.data.review).toEqual({ status: "pending" });
      expect(result.data.lifecycle.paused_at).toBeNull();
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

  it("accepts any event type and any payload keys (open payload decision for 1.0.0)", () => {
    for (const type of ["unit.done", "gate.provisional", "decision.raised", "steering.added"]) {
      const result = validateDeliveryEvent({
        ...minimalEvent,
        type,
        payload: { anything: [1, 2, 3], nested: { deep: true } },
      });
      expect(result.ok).toBe(true);
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

  it("SB-TC-017: the repository-reference guard passes over every tracked file", () => {
    const run = runGuard("repo-reference-guard.mjs");
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });
});

describe("delivery observation contract: compatibility", () => {
  it.each(contracts)(
    "SB-TC-019: the live $file stays compatible with its committed baseline",
    async ({ file }) => {
      const report = checkContractCompatibility(baselineSchema(file), await liveSchema(file));
      expect(report.reasons).toEqual([]);
      expect(report).toEqual(expect.objectContaining({ ok: true, change: "none" }));
    },
  );

  it("SB-TC-019: adding an optional field to the record passes once the minor is bumped", async () => {
    const file = "delivery-record.schema.json";
    const baseline = baselineSchema(file);
    const live = await liveSchema(file);
    const added = {
      ...live,
      properties: { ...(live.properties as JsonSchema), mode: { type: "string" } },
    };
    expect(classifySchemaChange(baseline, added)).toEqual({
      change: "additive",
      reasons: ["mode: new optional property"],
    });
    // Same version: the test fails until the version moves.
    expect(checkContractCompatibility(baseline, added).ok).toBe(false);
    // Minor bump: the test passes.
    const bumped = checkContractCompatibility(baseline, withId(added, "1.1.0"));
    expect(bumped.ok).toBe(true);
    expect(bumped.change).toBe("additive");
  });

  it("SB-TC-019: removing a required record field fails until the major is bumped", async () => {
    const file = "delivery-record.schema.json";
    const baseline = baselineSchema(file);
    const live = await liveSchema(file);
    const props = { ...(live.properties as JsonSchema) };
    delete props.seams;
    const removed = {
      ...live,
      properties: props,
      required: (live.required as string[]).filter((k) => k !== "seams"),
    };
    expect(classifySchemaChange(baseline, removed)).toEqual({
      change: "breaking",
      reasons: ["seams: property removed"],
    });
    expect(checkContractCompatibility(baseline, removed).ok).toBe(false);
    expect(checkContractCompatibility(baseline, withId(removed, "1.1.0")).ok).toBe(false);
    const major = checkContractCompatibility(baseline, withId(removed, "2.0.0"));
    expect(major.ok).toBe(true);
    expect(major.change).toBe("breaking");
  });

  it("SB-TC-019: requiring an optional envelope field is breaking, a new optional one is additive", async () => {
    const file = "delivery-event.schema.json";
    const baseline = baselineSchema(file);
    const live = await liveSchema(file);
    const required = live.required as string[];
    const nowRequired = { ...live, required: [...required, "unit_id"] };
    expect(classifySchemaChange(baseline, nowRequired).change).toBe("breaking");
    expect(checkContractCompatibility(baseline, withId(nowRequired, "1.1.0")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, withId(nowRequired, "2.0.0")).ok).toBe(true);

    const withActor = {
      ...live,
      properties: { ...(live.properties as JsonSchema), actor: { type: "string" } },
    };
    expect(checkContractCompatibility(baseline, withId(withActor, "1.1.0")).ok).toBe(true);
  });
});
