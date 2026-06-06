// Spike #408: generate:schema pipeline.
//
// Calls z.toJSONSchema() on the spike targeting zod source and writes the
// resulting JSON Schema into schema/. The checked-in output is the single
// source of truth consumed by the CI drift guard (see pr-check.yml): CI
// re-runs this script and `git diff --exit-code`s schema/, failing the build
// if the committed JSON Schema has drifted from the zod source.
//
// Scope (#408): this drives ONLY the spike artifact
// (schema/testbench-targeting.spike.schema.json). Wiring the generator over the
// real authored schemas (#6) into production CI is #7 and out of scope here.
//
// Run with: npm run generate:schema  (executes via tsx, the repo's TS runner)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import prettier from "prettier";
import { z } from "zod";
import { TestbenchTargetingSpikeSchema } from "../shared/testbench-targeting-schema.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// One entry per generated artifact. Adding the real schemas later is a matter
// of extending this list (under #6/#7), not rewriting the pipeline.
const artifacts = [
  {
    schema: TestbenchTargetingSpikeSchema,
    outPath: resolve(repoRoot, "schema", "testbench-targeting.spike.schema.json"),
  },
] as const;

for (const { schema, outPath } of artifacts) {
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
  const serialized = await prettier.format(JSON.stringify(jsonSchema, null, 2), {
    ...prettierOptions,
    parser: "json",
  });

  writeFileSync(outPath, serialized);
  console.log(`Wrote ${outPath}`);
}
