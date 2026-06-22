import { readFileSync } from "node:fs";
import { describe, it, expect, vi } from "vitest";
import { TEST_CASES_SCHEMA_ID, TEST_RESULTS_SCHEMA_ID } from "../shared/testbench-contracts.js";
import { TESTBENCH_TARGETING_SCHEMA_ID } from "../shared/testbench-targeting-schema.js";
import { WORK_UNITS_SCHEMA_ID } from "../shared/work-units-contract.js";
import { artifacts, renderSchema, generate } from "./generate-schema.js";

// The generated artifacts and their expected versioned $id. Each entry's
// outPath is the file the generator writes and the drift guard checks in.
const expected = [
  { name: "test-cases.schema.json", id: TEST_CASES_SCHEMA_ID },
  { name: "test-results.schema.json", id: TEST_RESULTS_SCHEMA_ID },
  { name: "testbench-targeting.spike.schema.json", id: TESTBENCH_TARGETING_SCHEMA_ID },
  { name: "work-units.schema.json", id: WORK_UNITS_SCHEMA_ID },
];

describe("generate-schema artifacts list", () => {
  it("emits one entry per published schema, real contracts plus the spike", () => {
    const names = artifacts.map((a) => a.outPath.split("/").pop());
    expect(names).toEqual(expected.map((e) => e.name));
  });
});

describe.each(expected)("generated $name", ({ name, id }) => {
  const artifact = artifacts.find((a) => a.outPath.endsWith(name));
  if (!artifact) throw new Error(`no artifact for ${name}`);

  it("carries the expected semver $id", async () => {
    const rendered = JSON.parse(await renderSchema(artifact.schema, artifact.outPath));
    expect(rendered.$id).toBe(id);
    // The $id embeds a semver path segment (vX.Y.Z), per the #1 spike decision.
    expect(rendered.$id).toMatch(/\/v\d+\.\d+\.\d+\.json$/);
  });

  it("is byte-stable: re-rendering reproduces the committed file exactly", async () => {
    const committed = readFileSync(artifact.outPath, "utf8");
    const rerendered = await renderSchema(artifact.schema, artifact.outPath);
    expect(rerendered).toBe(committed);
  });
});

describe("generate()", () => {
  it("writes every artifact and logs each path without re-introducing drift", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // generate() writes the real files; since they are already committed and the
    // render is pure, this is a no-op on disk that exercises the write loop.
    await generate();
    expect(log).toHaveBeenCalledTimes(artifacts.length);
    for (const { outPath } of artifacts) {
      expect(log).toHaveBeenCalledWith(`Wrote ${outPath}`);
    }
    // Confirm the on-disk bytes still match what the pure renderer produces.
    for (const { schema, outPath } of artifacts) {
      expect(readFileSync(outPath, "utf8")).toBe(await renderSchema(schema, outPath));
    }
  });
});
