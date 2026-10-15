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
      properties: { ...(baseline.properties as JsonSchema), mode: { type: "string" } },
    };
    expect(classifySchemaChange(baseline, added)).toEqual({
      change: "additive",
      reasons: ["mode: new optional property"],
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
