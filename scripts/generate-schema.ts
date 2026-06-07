// generate:schema pipeline.
//
// Calls z.toJSONSchema() on the testbench-contracts zod source and writes the
// resulting JSON Schema into schema/. The checked-in output is the single
// source of truth consumed by the CI drift guard (see pr-check.yml): CI
// re-runs this script and `git diff --exit-code`s schema/, failing the build
// if the committed JSON Schema has drifted from the zod source.
//
// Scope (#411): this drives the real authored TestBench contracts
// (schema/test-cases.schema.json, schema/test-results.schema.json) plus the
// retained #408 spike artifact. Retrofitting generation onto the
// roubo-config/roubo-plugin schemas is out of scope.
//
// Run with: npm run generate:schema  (executes via tsx, the repo's TS runner)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import prettier from "prettier";
import { z } from "zod";
import { TestbenchTargetingSpikeSchema } from "../shared/testbench-targeting-schema.ts";
import { TestCasesPlanSchema, TestResultsFileSchema } from "../shared/testbench-contracts.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "..");

// One entry per generated artifact. Adding a schema is a matter of extending
// this list, not rewriting the pipeline.
export const artifacts = [
  {
    schema: TestCasesPlanSchema,
    outPath: resolve(repoRoot, "schema", "test-cases.schema.json"),
  },
  {
    schema: TestResultsFileSchema,
    outPath: resolve(repoRoot, "schema", "test-results.schema.json"),
  },
  {
    schema: TestbenchTargetingSpikeSchema,
    outPath: resolve(repoRoot, "schema", "testbench-targeting.spike.schema.json"),
  },
] as const;

// Render one zod schema to the exact bytes we commit. Kept pure (no IO) so the
// drift guard and the unit tests can both assert byte-stability against the
// committed files without re-running the file-writing side effects.
export async function renderSchema(schema: z.ZodType, outPath: string): Promise<string> {
  // `target: "draft-2020-12"` is zod's default; stated explicitly so the
  // dialect is pinned and a zod default change cannot silently move it.
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-2020-12" });

  // Format with prettier using the repo's own config so the generated file
  // matches both `format:check` AND a byte-for-byte re-generation. Without this
  // the raw JSON.stringify output differs from prettier's (it collapses short
  // arrays onto one line), which would make the CI drift guard fire on every
  // run. The guard depends on this script being a pure function of the zod
  // source whose output already satisfies prettier.
  const prettierOptions = await prettier.resolveConfig(outPath);
  return prettier.format(JSON.stringify(jsonSchema, null, 2), {
    ...prettierOptions,
    parser: "json",
  });
}

export async function generate(): Promise<void> {
  for (const { schema, outPath } of artifacts) {
    const serialized = await renderSchema(schema, outPath);
    writeFileSync(outPath, serialized);
    console.log(`Wrote ${outPath}`);
  }
}

// Run the pipeline only when executed directly (npm run generate:schema),
// never on import: importing this module from a test must not write files.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generate();
}
