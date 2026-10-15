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
  STATE_RECIPE_SCHEMA_ID,
  STATE_RECIPE_SCHEMA_VERSION,
  STATE_RECIPE_STEP_KINDS,
  StateRecipeSchema,
  validateStateRecipe,
} from "./state-recipe-contract.js";

const FILE = "state-recipe.schema.json";
const SOURCE = join(repoRoot, "shared", "state-recipe-contract.ts");
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
  "caseId",
  "unitId",
  "commit",
  "requires",
  "steps",
  "observation",
];

const commandStep = { kind: "command", command: "npm run build" };
const copyFileStep = {
  kind: "copy-file",
  from: "fixtures/settings.json",
  to: ".roubo/settings.json",
};
const httpStep = {
  kind: "http",
  method: "POST",
  url: "http://127.0.0.1:4100/api/benches",
  headers: { "content-type": "application/json" },
  body: '{"name":"demo"}',
};
const openUrlStep = { kind: "open-url", url: "http://127.0.0.1:4100/benches/demo" };

const recipe = {
  $schema: STATE_RECIPE_SCHEMA_ID,
  schemaVersion: STATE_RECIPE_SCHEMA_VERSION,
  caseId: "DEMO-TC-001",
  unitId: "demo-unit-1",
  commit: "d1b2c522900a760bca8835c8babebbdff3fe48ba",
  requires: ["node", "docker"],
  steps: [commandStep, copyFileStep, httpStep, openUrlStep],
  observation: { description: "The bench list shows one bench named demo." },
};

describe("state recipe contract: generated schema", () => {
  it("is zod in shared with a versioned $id at 1.0.0 and its committed JSON equals a fresh render", async () => {
    expect(STATE_RECIPE_SCHEMA_VERSION).toBe("1.0.0");
    expect(STATE_RECIPE_SCHEMA_ID).toMatch(/\/v1\.0\.0\.json$/);
    expect(StateRecipeSchema.meta()?.$id).toBe(STATE_RECIPE_SCHEMA_ID);

    // The generator lists it, and the committed artifact under schema/ is
    // byte-equal to a fresh render, which is what the CI drift gate checks.
    const a = artifact();
    const rendered = await renderSchema(a.schema, a.outPath);
    expect(readFileSync(a.outPath, "utf8")).toBe(rendered);
    expect(JSON.parse(rendered).$id).toBe(STATE_RECIPE_SCHEMA_ID);
  });

  it("renders the $schema and schemaVersion constants, the required fields and the four step kinds", async () => {
    const live = await liveSchema();
    const props = live.properties as Record<string, JsonSchema>;
    expect(props.$schema.const).toBe(STATE_RECIPE_SCHEMA_ID);
    expect(props.schemaVersion.const).toBe(STATE_RECIPE_SCHEMA_VERSION);
    expect(live.required).toEqual(REQUIRED_FIELDS);
    // zod renders a discriminated union as `oneOf`, one option per kind.
    const items = props.steps.items as JsonSchema;
    const options = items.oneOf as JsonSchema[];
    const kinds = options.map((o) => ((o.properties as JsonSchema).kind as JsonSchema).const);
    expect(kinds).toEqual(["command", "copy-file", "http", "open-url"]);
    expect(STATE_RECIPE_STEP_KINDS).toEqual(kinds);
  });
});

describe("state recipe contract: validation", () => {
  it("accepts a recipe with one step of each of the four kinds", () => {
    const result = validateStateRecipe(recipe);
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.data.steps.map((s) => s.kind)).toEqual([
        "command",
        "copy-file",
        "http",
        "open-url",
      ]);
      expect(result.data.requires).toEqual(["node", "docker"]);
    }
  });

  it("accepts an empty requires list and an empty steps list", () => {
    const result = validateStateRecipe({ ...recipe, requires: [], steps: [] });
    expect(result.ok).toBe(true);
  });

  it("requires every field, with a field-named error for each", () => {
    expect(Object.keys(StateRecipeSchema.shape)).toEqual(REQUIRED_FIELDS);
    for (const key of REQUIRED_FIELDS) {
      const broken = Object.fromEntries(Object.entries(recipe).filter(([k]) => k !== key));
      const result = validateStateRecipe(broken);
      expect(result.ok, key).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.startsWith(`${key}:`))).toBe(true);
    }
  });

  it("rejects a step of an unknown kind and names the step index", () => {
    const result = validateStateRecipe({
      ...recipe,
      steps: [commandStep, copyFileStep, { kind: "wait", seconds: 2 }, openUrlStep],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "steps.2.kind: unknown step kind: expected one of command, copy-file, http, open-url",
      ]);
    }
  });

  it("names every offending index when more than one step has an unknown kind", () => {
    const result = validateStateRecipe({
      ...recipe,
      steps: [{ kind: "sleep" }, commandStep, { kind: "" }, { command: "no kind" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.split(":")[0])).toEqual([
        "steps.0.kind",
        "steps.2.kind",
        "steps.3.kind",
      ]);
    }
  });

  it("rejects a step of a known kind that misses a field, at the step's index and field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ kind: "command" }, "steps.0.command:"],
      [{ kind: "copy-file", from: "a" }, "steps.0.to:"],
      [{ kind: "http", method: "GET" }, "steps.0.url:"],
      [{ kind: "http", method: "GET", url: "not a url" }, "steps.0.url:"],
      [{ kind: "open-url", url: "" }, "steps.0.url:"],
    ];
    for (const [step, prefix] of cases) {
      const result = validateStateRecipe({ ...recipe, steps: [step] });
      expect(result.ok, prefix).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.startsWith(prefix))).toBe(true);
    }
  });

  it("rejects an empty commit, an empty requirement and an observation with no description", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...recipe, commit: "" }, "commit:"],
      [{ ...recipe, requires: ["node", ""] }, "requires.1:"],
      [{ ...recipe, observation: {} }, "observation.description:"],
    ];
    for (const [broken, prefix] of cases) {
      const result = validateStateRecipe(broken);
      expect(result.ok, prefix).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.startsWith(prefix))).toBe(true);
    }
  });

  it("rejects a wrong $schema or schemaVersion", () => {
    const otherId = "https://roubo.dev/schema/delivery-control/v1.0.0.json";
    expect(validateStateRecipe({ ...recipe, $schema: otherId }).ok).toBe(false);
    expect(validateStateRecipe({ ...recipe, schemaVersion: "2.0.0" }).ok).toBe(false);
  });

  it("keeps an unknown key at the root, on a step and in the observation (additive posture)", () => {
    const result = validateStateRecipe({
      ...recipe,
      recorded_at: "2026-10-16T09:00:00Z",
      steps: [{ ...commandStep, timeout_ms: 5000 }],
      observation: { ...recipe.observation, url: "http://127.0.0.1:4100/benches" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.recorded_at).toBe("2026-10-16T09:00:00Z");
      expect(result.data.steps[0].timeout_ms).toBe(5000);
      expect(result.data.observation.url).toBe("http://127.0.0.1:4100/benches");
    }
  });

  it.each([[null], [undefined], ["recipe"], [7], [[]]])(
    "rejects the non-object value %s",
    (value) => {
      expect(validateStateRecipe(value).ok).toBe(false);
    },
  );
});

describe("state recipe contract: guards", () => {
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

describe("state recipe contract: compatibility", () => {
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

  it("an optional field on a step is additive and needs a minor bump", () => {
    const baseline = baselineSchema();
    const props = baseline.properties as Record<string, JsonSchema>;
    const items = props.steps.items as JsonSchema;
    const options = items.oneOf as JsonSchema[];
    const [command, ...rest] = options;
    const grown = {
      ...baseline,
      properties: {
        ...props,
        steps: {
          ...props.steps,
          items: {
            ...items,
            oneOf: [
              {
                ...command,
                properties: {
                  ...(command.properties as JsonSchema),
                  timeout_ms: { type: "integer" },
                },
              },
              ...rest,
            ],
          },
        },
      },
    };
    expect(classifySchemaChange(baseline, grown)).toEqual({
      change: "additive",
      reasons: ["steps[].oneOf.0.timeout_ms: new optional property"],
    });
    expect(checkContractCompatibility(baseline, grown).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(grown, "patch")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(grown, "minor")).ok).toBe(true);
  });

  it("removing requires is breaking and needs a major bump", () => {
    const baseline = baselineSchema();
    const props = { ...(baseline.properties as JsonSchema) };
    delete props.requires;
    const removed = {
      ...baseline,
      properties: props,
      required: (baseline.required as string[]).filter((k) => k !== "requires"),
    };
    expect(classifySchemaChange(baseline, removed)).toEqual({
      change: "breaking",
      reasons: ["requires: property removed"],
    });
    expect(checkContractCompatibility(baseline, bumped(removed, "minor")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(removed, "major")).ok).toBe(true);
  });
});
