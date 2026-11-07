// The state recipe replayer (SB-FR-025): it runs only the four step kinds of
// the contract, in order, and stops at the first that fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STATE_RECIPE_SCHEMA_ID,
  STATE_RECIPE_SCHEMA_VERSION,
  type StateRecipe,
} from "@roubo/shared/state-recipe-contract";
import {
  recipeCommitMatches,
  replayStateRecipe,
  UnknownStateRecipeStepError,
  type StateRecipeReplayDeps,
} from "./state-recipe-replay.js";

let checkout: string;

function recipe(steps: StateRecipe["steps"]): StateRecipe {
  return {
    $schema: STATE_RECIPE_SCHEMA_ID,
    schemaVersion: STATE_RECIPE_SCHEMA_VERSION,
    caseId: "FX-TC-001",
    unitId: "FX-UNIT-B",
    commit: "0123456",
    requires: [],
    steps,
    observation: { description: "The banner reads staged" },
  };
}

function deps(status = 200): StateRecipeReplayDeps & {
  runCommand: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
} {
  return {
    runCommand: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    fetch: vi.fn(async () => new Response(null, { status })),
  } as never;
}

beforeEach(() => {
  checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roubo-replay-")));
});

afterEach(() => {
  fs.rmSync(checkout, { recursive: true, force: true });
});

describe("replayStateRecipe", () => {
  it("SB-TC-062 refuses a step of an unknown kind before any step runs", async () => {
    const fake = deps();
    const steps = [
      { kind: "command", command: "true" },
      { kind: "launch-rocket", target: "moon" },
    ] as unknown as StateRecipe["steps"];
    const replay = replayStateRecipe(recipe(steps), checkout, fake);
    await expect(replay).rejects.toBeInstanceOf(UnknownStateRecipeStepError);
    await expect(replay).rejects.toThrow(/Step 1 has the unknown kind "launch-rocket"/);
    expect(fake.runCommand).not.toHaveBeenCalled();
  });

  it("SB-TC-062 runs the four step kinds in order in the checkout", async () => {
    fs.writeFileSync(path.join(checkout, "seed.json"), "{}");
    const fake = deps(204);
    const result = await replayStateRecipe(
      recipe([
        { kind: "command", command: "npm run seed", cwd: "app", env: { SEED: "1" } },
        { kind: "copy-file", from: "seed.json", to: "data/seed.json", mode: "create-only" },
        { kind: "http", method: "POST", url: "http://localhost:4000/api/reset", body: "{}" },
        { kind: "open-url", url: "http://localhost:5173/" },
      ]),
      checkout,
      fake,
    );
    expect(result.ok).toBe(true);
    expect(result.report.steps.map((s) => [s.kind, s.status])).toEqual([
      ["command", "passed"],
      ["copy-file", "passed"],
      ["http", "passed"],
      ["open-url", "passed"],
    ]);
    expect(result.report.steps[3].url).toBe("http://localhost:5173/");
    expect(fake.runCommand).toHaveBeenCalledWith(
      "/bin/sh",
      ["-c", "npm run seed"],
      path.join(checkout, "app"),
      { SEED: "1" },
      120_000,
    );
    expect(fake.fetch).toHaveBeenCalledWith(
      "http://localhost:4000/api/reset",
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
    expect(fs.readFileSync(path.join(checkout, "data", "seed.json"), "utf8")).toBe("{}");
  });

  it("fails a step on an unexpected status and skips the steps after it", async () => {
    const fake = deps(500);
    const result = await replayStateRecipe(
      recipe([
        { kind: "http", method: "GET", url: "http://localhost:4000/" },
        { kind: "command", command: "true" },
      ]),
      checkout,
      fake,
    );
    expect(result.ok).toBe(false);
    expect(result.report.steps).toEqual([
      { index: 0, kind: "http", status: "failed", detail: "answered 500, expected a 2xx" },
      { index: 1, kind: "command", status: "skipped" },
    ]);
    expect(fake.runCommand).not.toHaveBeenCalled();
  });

  it("fails a create-only copy onto a file that exists, and a path that leaves the checkout", async () => {
    fs.writeFileSync(path.join(checkout, "a.txt"), "a");
    fs.writeFileSync(path.join(checkout, "b.txt"), "b");
    const exists = await replayStateRecipe(
      recipe([{ kind: "copy-file", from: "a.txt", to: "b.txt", mode: "create-only" }]),
      checkout,
      deps(),
    );
    expect(exists.report.steps[0].status).toBe("failed");
    expect(fs.readFileSync(path.join(checkout, "b.txt"), "utf8")).toBe("b");
    const escapes = await replayStateRecipe(
      recipe([{ kind: "command", command: "true", cwd: "../elsewhere" }]),
      checkout,
      deps(),
    );
    expect(escapes.report.steps[0]).toMatchObject({ status: "failed" });
    expect(escapes.report.steps[0].detail).toContain("escapes root");
  });
});

describe("recipeCommitMatches", () => {
  it("matches the full commit and an abbreviation of it, and nothing else", () => {
    const full = "0123456789abcdef0123456789abcdef01234567";
    expect(recipeCommitMatches(full, full)).toBe(true);
    expect(recipeCommitMatches("0123456", full)).toBe(true);
    expect(recipeCommitMatches("0123457", full)).toBe(false);
    expect(recipeCommitMatches("main", full)).toBe(false);
    expect(recipeCommitMatches("012", full)).toBe(false);
  });
});
