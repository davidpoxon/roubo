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
  DELIVERY_CONTROL_KINDS,
  DELIVERY_CONTROL_SCHEMA_ID,
  DELIVERY_CONTROL_SCHEMA_VERSION,
  DeliveryControlSchema,
  validateDeliveryControl,
} from "./delivery-control-contract.js";

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

const REQUIRED_FIELDS = [
  "$schema",
  "schemaVersion",
  "delivery_id",
  "control_seq",
  "kind",
  "body",
  "issued_at",
  "status",
];

const minimalControl = {
  $schema: DELIVERY_CONTROL_SCHEMA_ID,
  schemaVersion: DELIVERY_CONTROL_SCHEMA_VERSION,
  delivery_id: "demo-delivery-1",
  control_seq: 1,
  kind: "decision-answer",
  target_id: "demo-decision-1",
  body: { option: "one file per unit" },
  issued_at: "2026-10-16T09:00:00Z",
  status: "pending",
};

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

  it("renders the $schema and schemaVersion constants and the eight kinds as an enum", async () => {
    const live = await liveSchema();
    const props = live.properties as Record<string, JsonSchema>;
    expect(props.$schema.const).toBe(DELIVERY_CONTROL_SCHEMA_ID);
    expect(props.schemaVersion.const).toBe(DELIVERY_CONTROL_SCHEMA_VERSION);
    expect(props.kind.enum).toEqual([
      "decision-answer",
      "overturn",
      "steering-note",
      "role-change",
      "pause",
      "wind-down",
      "resume",
      "approval",
    ]);
    expect(live.required).toEqual(REQUIRED_FIELDS);
    expect(Object.keys(props)).toContain("target_id");
  });
});

describe("delivery control contract: validation", () => {
  it("accepts a control of each of the eight kinds", () => {
    expect(DELIVERY_CONTROL_KINDS).toHaveLength(8);
    DELIVERY_CONTROL_KINDS.forEach((kind, index) => {
      const result = validateDeliveryControl({ ...minimalControl, kind, control_seq: index + 1 });
      expect(result, kind).toEqual(expect.objectContaining({ ok: true }));
      if (result.ok) expect(result.data.kind).toBe(kind);
    });
  });

  it("accepts a delivery-wide control with no target_id", () => {
    const rest = Object.fromEntries(
      Object.entries(minimalControl).filter(([k]) => k !== "target_id"),
    );
    const result = validateDeliveryControl({ ...rest, kind: "pause", body: {} });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.target_id).toBeUndefined();
  });

  it("requires every field but target_id, with a field-named error for each", () => {
    expect(Object.keys(DeliveryControlSchema.shape)).toEqual([
      ...REQUIRED_FIELDS.slice(0, 5),
      "target_id",
      ...REQUIRED_FIELDS.slice(5),
    ]);
    for (const key of REQUIRED_FIELDS) {
      const broken = Object.fromEntries(Object.entries(minimalControl).filter(([k]) => k !== key));
      const result = validateDeliveryControl(broken);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.startsWith(`${key}:`))).toBe(true);
    }
  });

  it("rejects a kind outside the eight with an error at kind", () => {
    const result = validateDeliveryControl({ ...minimalControl, kind: "nudge" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^kind: /);
    }
  });

  it("rejects a zero control_seq, a non-object body, an empty status and a bad timestamp", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...minimalControl, control_seq: 0 }, "control_seq:"],
      [{ ...minimalControl, control_seq: 1.5 }, "control_seq:"],
      [{ ...minimalControl, body: "text" }, "body:"],
      [{ ...minimalControl, status: "" }, "status:"],
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

  it("keeps an unknown key at the root and any key in the body (additive posture)", () => {
    const result = validateDeliveryControl({
      ...minimalControl,
      kind: "role-change",
      target_id: "unit-coder",
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
  });

  it("a ninth kind is an additive change that needs a minor bump", () => {
    const baseline = baselineSchema();
    const props = baseline.properties as Record<string, JsonSchema>;
    const grown = {
      ...baseline,
      properties: {
        ...props,
        kind: { ...props.kind, enum: [...(props.kind.enum as string[]), "nudge"] },
      },
    };
    expect(classifySchemaChange(baseline, grown)).toEqual({
      change: "additive",
      reasons: ["kind: enum gained a value"],
    });
    expect(checkContractCompatibility(baseline, grown).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(grown, "patch")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(grown, "minor")).ok).toBe(true);
  });

  it("dropping a kind or requiring target_id is breaking and needs a major bump", () => {
    const baseline = baselineSchema();
    const props = baseline.properties as Record<string, JsonSchema>;
    const lost = {
      ...baseline,
      properties: {
        ...props,
        kind: {
          ...props.kind,
          enum: (props.kind.enum as string[]).filter((k) => k !== "overturn"),
        },
      },
    };
    expect(classifySchemaChange(baseline, lost).change).toBe("breaking");
    expect(checkContractCompatibility(baseline, bumped(lost, "minor")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(lost, "major")).ok).toBe(true);

    const nowRequired = {
      ...baseline,
      required: [...(baseline.required as string[]), "target_id"],
    };
    expect(classifySchemaChange(baseline, nowRequired).change).toBe("breaking");
    expect(checkContractCompatibility(baseline, bumped(nowRequired, "major")).ok).toBe(true);
  });
});
