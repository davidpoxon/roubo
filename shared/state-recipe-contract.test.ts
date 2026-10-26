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
  COPY_FILE_MODES,
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

// One step of each kind with only its required fields: a recipe written before
// the optional fields existed must still validate.
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

// The same steps with every optional field of 1.0.0 filled in.
const richCommandStep = {
  ...commandStep,
  cwd: "client",
  env: { CI: "1" },
  timeoutMs: 120000,
  expectedExitCode: 0,
};
const richCopyFileStep = { ...copyFileStep, mode: "create-only" };
const richHttpStep = { ...httpStep, timeoutMs: 5000, expectedStatus: 201 };
const richObservation = {
  description: "The bench list shows one bench named demo.",
  url: "http://127.0.0.1:4100/benches",
  path: ".roubo/benches/demo.yaml",
  selector: "[data-bench-name='demo']",
};

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

  it("renders each step kind's richer fields as optional, and the observation's locations", async () => {
    const live = await liveSchema();
    const props = live.properties as Record<string, JsonSchema>;
    const options = (props.steps.items as JsonSchema).oneOf as JsonSchema[];
    const fields = (o: JsonSchema) => Object.keys(o.properties as JsonSchema);
    const [command, copyFile, http, openUrl] = options;
    expect(fields(command)).toEqual([
      "kind",
      "command",
      "cwd",
      "env",
      "timeoutMs",
      "expectedExitCode",
    ]);
    expect(command.required).toEqual(["kind", "command"]);
    expect(fields(copyFile)).toEqual(["kind", "from", "to", "mode"]);
    expect(copyFile.required).toEqual(["kind", "from", "to"]);
    const copyFileProps = copyFile.properties as Record<string, JsonSchema>;
    expect(copyFileProps.mode.enum).toEqual(COPY_FILE_MODES);
    expect(fields(http)).toEqual([
      "kind",
      "method",
      "url",
      "headers",
      "body",
      "timeoutMs",
      "expectedStatus",
    ]);
    expect(http.required).toEqual(["kind", "method", "url"]);
    expect(fields(openUrl)).toEqual(["kind", "url"]);
    for (const option of options) expect(option.additionalProperties).toEqual({});

    expect(Object.keys(props.observation.properties as JsonSchema)).toEqual([
      "description",
      "url",
      "path",
      "selector",
    ]);
    expect(props.observation.required).toEqual(["description"]);
    expect(props.observation.additionalProperties).toEqual({});
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

  it("accepts the richer optional step fields and the observation's locations", () => {
    const result = validateStateRecipe({
      ...recipe,
      steps: [richCommandStep, richCopyFileStep, richHttpStep, openUrlStep],
      observation: richObservation,
    });
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) {
      expect(result.data.steps[0]).toEqual(richCommandStep);
      expect(result.data.steps[1]).toEqual(richCopyFileStep);
      expect(result.data.steps[2]).toEqual(richHttpStep);
      expect(result.data.observation).toEqual(richObservation);
    }
    for (const mode of COPY_FILE_MODES) {
      const step = { ...copyFileStep, mode };
      expect(validateStateRecipe({ ...recipe, steps: [step] }).ok, mode).toBe(true);
    }
  });

  it("rejects an out-of-range optional field at the step's index and field", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...commandStep, timeoutMs: 0 }, "steps.0.timeoutMs:"],
      [{ ...commandStep, timeoutMs: 1.5 }, "steps.0.timeoutMs:"],
      [{ ...commandStep, expectedExitCode: -1 }, "steps.0.expectedExitCode:"],
      [{ ...commandStep, expectedExitCode: 256 }, "steps.0.expectedExitCode:"],
      [{ ...copyFileStep, mode: "append" }, "steps.0.mode:"],
      [{ ...copyFileStep, mode: "" }, "steps.0.mode:"],
      [{ ...httpStep, timeoutMs: "5s" }, "steps.0.timeoutMs:"],
      [{ ...httpStep, expectedStatus: 99 }, "steps.0.expectedStatus:"],
      [{ ...httpStep, expectedStatus: 600 }, "steps.0.expectedStatus:"],
      [{ ...httpStep, expectedStatus: "201" }, "steps.0.expectedStatus:"],
    ];
    for (const [step, prefix] of cases) {
      const result = validateStateRecipe({ ...recipe, steps: [step] });
      expect(result.ok, prefix).toBe(false);
      if (!result.ok) {
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].startsWith(prefix), result.errors[0]).toBe(true);
      }
    }
  });

  it("rejects an observation location that is not a URL or is empty", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...richObservation, url: "benches" }, "observation.url:"],
      [{ ...richObservation, path: "" }, "observation.path:"],
      [{ ...richObservation, selector: "" }, "observation.selector:"],
      [{ ...richObservation, selector: 7 }, "observation.selector:"],
    ];
    for (const [observation, prefix] of cases) {
      const result = validateStateRecipe({ ...recipe, observation });
      expect(result.ok, prefix).toBe(false);
      if (!result.ok) expect(result.errors).toEqual([expect.stringMatching(`^${prefix}`)]);
    }
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
      steps: [{ ...commandStep, retries: 2 }],
      observation: { ...recipe.observation, note: "Scroll down when the list is long." },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.recorded_at).toBe("2026-10-16T09:00:00Z");
      expect(result.data.steps[0].retries).toBe(2);
      expect(result.data.observation.note).toBe("Scroll down when the list is long.");
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

  // The baseline with its step options replaced.
  function withSteps(baseline: JsonSchema, oneOf: JsonSchema[]): JsonSchema {
    const props = baseline.properties as Record<string, JsonSchema>;
    const items = props.steps.items as JsonSchema;
    return {
      ...baseline,
      properties: { ...props, steps: { ...props.steps, items: { ...items, oneOf } } },
    };
  }
  function stepOptions(baseline: JsonSchema): JsonSchema[] {
    const props = baseline.properties as Record<string, JsonSchema>;
    return (props.steps.items as JsonSchema).oneOf as JsonSchema[];
  }

  it("an optional field on a step is additive and needs a minor bump", () => {
    const baseline = baselineSchema();
    const [command, ...rest] = stepOptions(baseline);
    const grown = withSteps(baseline, [
      {
        ...command,
        properties: { ...(command.properties as JsonSchema), retries: { type: "integer" } },
      },
      ...rest,
    ]);
    expect(classifySchemaChange(baseline, grown)).toEqual({
      change: "additive",
      reasons: ["steps[].oneOf.command.retries: new optional property"],
    });
    expect(checkContractCompatibility(baseline, grown).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(grown, "patch")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(grown, "minor")).ok).toBe(true);
  });

  it("a fifth step kind is additive wherever it sits in the oneOf; a lost kind is breaking", () => {
    const baseline = baselineSchema();
    const steps = stepOptions(baseline);
    const wait = {
      type: "object",
      properties: { kind: { type: "string", const: "wait" }, seconds: { type: "integer" } },
      required: ["kind", "seconds"],
      additionalProperties: {},
    };
    const expected = {
      change: "additive",
      reasons: ['steps[]: oneOf gained the option kind="wait"'],
    };
    expect(classifySchemaChange(baseline, withSteps(baseline, [...steps, wait]))).toEqual(expected);
    expect(
      classifySchemaChange(baseline, withSteps(baseline, [steps[0], wait, ...steps.slice(1)])),
    ).toEqual(expected);
    const appended = bumped(withSteps(baseline, [...steps, wait]), "minor");
    expect(checkContractCompatibility(baseline, appended).ok).toBe(true);

    const lost = withSteps(
      baseline,
      steps.filter((_, i) => i !== 1),
    );
    expect(classifySchemaChange(baseline, lost)).toEqual({
      change: "breaking",
      reasons: ['steps[]: oneOf lost the option kind="copy-file"'],
    });
    expect(checkContractCompatibility(baseline, bumped(lost, "minor")).ok).toBe(false);
    expect(checkContractCompatibility(baseline, bumped(lost, "major")).ok).toBe(true);
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
