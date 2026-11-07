// GET /:projectId/specbench/specs/:slug/summary: the units-and-gates summary
// that the Set up Spec Bench dialog shows (SB-FR-001, SB-TC-006 step 2), and
// the delivery record committed where a new bench's worktree would start
// (SB-FR-003, SB-TC-007 step 2).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_RECORD_FILE } from "@roubo/shared/delivery-bench";
import type { DeliveryRecord } from "@roubo/shared/delivery-observation-contract";

vi.mock("../services/project-registry.js", () => ({
  getProject: vi.fn(),
}));

import * as projectRegistry from "../services/project-registry.js";
import {
  DELIVERY_RECORD_MAX_BYTES,
  loadCommittedDeliveryRecord,
} from "../lib/delivery-record-loader.js";
import router from "./specbench-specs.js";

const FIXTURE_RECORD = fileURLToPath(
  new URL("../../shared/__fixtures__/delivery-record.json", import.meta.url),
);

function writeRecord(slug: string, body: unknown, root = repo): string {
  const folder = path.join(root, ".specifications", slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, DELIVERY_RECORD_FILE), JSON.stringify(body));
  return path.join(".specifications", slug, DELIVERY_RECORD_FILE);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function commitRecord(slug: string, body: unknown, root = repo): void {
  git(root, "add", "--", writeRecord(slug, body, root));
  git(root, "commit", "-q", "-m", "record");
}

function twoUnitsIn(): DeliveryRecord {
  const record = JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
  record.units = record.units.map((item) => ({
    ...item,
    status: item.id === "A" || item.id === "B" ? "done" : "pending",
  }));
  return record;
}

function deliveryOf(record: DeliveryRecord, unitsDone: number) {
  return {
    deliveryId: record.delivery_id,
    lifecycleState: record.lifecycle.state,
    unitsDone,
    units: record.units.length,
  };
}

function useWorktreeSource(branchFromDefault: boolean, pullLatest: boolean): void {
  vi.mocked(projectRegistry.getProject).mockReturnValue({
    id: "demo",
    repoPath: repo,
    config: {},
    settings: { worktreeSource: { branchFromDefault, pullLatest } },
  } as unknown as ReturnType<typeof projectRegistry.getProject>);
}

// An origin for the checkout, with `main` as its default branch, and a second
// clone of it that pushes there.
function withOrigin(): string {
  const origin = path.join(scratch, "origin.git");
  git(scratch, "clone", "-q", "--bare", repo, origin);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "fetch", "-q", "origin");
  git(repo, "remote", "set-head", "origin", "main");
  const other = path.join(scratch, "other");
  git(scratch, "clone", "-q", origin, other);
  return other;
}

const SUMMARY = "/api/projects/demo/specbench/specs/fixture-spec/summary";

let scratch: string;
let repo: string;
let app: express.Express;

function unit(id: string, kind?: "verify" | "e2e") {
  return {
    id,
    title: `Unit ${id}`,
    type: kind === "verify" ? "task" : "feature",
    ...(kind && { kind }),
    description: `Unit ${id}`,
    acceptance_criteria: ["It works"],
    milestone: "Phase 1",
    labels: [],
    estimate: 1,
    depends_on: [],
    implements: { requirement_ids: [], user_story_ids: [], test_case_ids: ["TC-001"] },
  };
}

function writeWorkUnits(slug: string, body: unknown): void {
  const folder = path.join(repo, ".specifications", slug);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "work-units.json"), JSON.stringify(body));
}

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "specbench-specs-")));
  repo = path.join(scratch, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  useWorktreeSource(false, false);
  app = express();
  app.use("/api/projects", router);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("GET /:projectId/specbench/specs/:slug/summary", () => {
  it("SB-TC-006: counts the spec's delivery units and its verify gates", async () => {
    writeWorkUnits("fixture-spec", {
      $schema: "https://roubo.dev/schema/work-units/v1.0.0.json",
      schemaVersion: "1.0.0",
      specSlug: "fixture-spec",
      units: [
        unit("A"),
        unit("B"),
        unit("G1", "verify"),
        unit("C"),
        unit("G2", "verify"),
        unit("D", "e2e"),
      ],
    });
    const res = await request(app).get("/api/projects/demo/specbench/specs/fixture-spec/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "fixture-spec", units: 4, gates: 2 });
  });

  it("SB-TC-007: names the progress and lifecycle state of a committed delivery record", async () => {
    const record = twoUnitsIn();
    commitRecord("fixture-spec", record);
    const res = await request(app).get(SUMMARY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      slug: "fixture-spec",
      units: 0,
      gates: 0,
      delivery: deliveryOf(record, 2),
    });
  });

  it("SB-TC-007: names no delivery for a record copied into the checkout but not committed", async () => {
    writeRecord("fixture-spec", twoUnitsIn());
    const res = await request(app).get(SUMMARY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "fixture-spec", units: 0, gates: 0 });
  });

  it("SB-TC-007: names the committed record, not a newer edit of it in the working tree", async () => {
    const record = twoUnitsIn();
    commitRecord("fixture-spec", record);
    writeRecord("fixture-spec", {
      ...record,
      units: record.units.map((item) => ({ ...item, status: "done" })),
      lifecycle: { ...record.lifecycle, state: "paused" },
    });
    const res = await request(app).get(SUMMARY);
    expect(res.body.delivery).toEqual(deliveryOf(record, 2));
  });

  it("SB-TC-007: names no delivery for a committed record that does not conform", async () => {
    commitRecord("fixture-spec", { units: [] });
    const res = await request(app).get(SUMMARY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "fixture-spec", units: 0, gates: 0 });
  });

  it("SB-TC-007: with Branch from default branch, reads the default branch, not the checked-out one", async () => {
    withOrigin();
    useWorktreeSource(true, false);
    git(repo, "checkout", "-q", "-b", "feature");
    commitRecord("fixture-spec", twoUnitsIn());
    const res = await request(app).get(SUMMARY);
    expect(res.body).toEqual({ slug: "fixture-spec", units: 0, gates: 0 });

    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--ff-only", "feature");
    const merged = await request(app).get(SUMMARY);
    expect(merged.body.delivery).toEqual(deliveryOf(twoUnitsIn(), 2));
  });

  it("SB-TC-007: with Pull latest, reads origin's branch as last fetched when it is ahead of the local one", async () => {
    const other = withOrigin();
    useWorktreeSource(true, true);
    commitRecord("fixture-spec", twoUnitsIn(), other);
    git(other, "push", "-q", "origin", "main");
    const unfetched = await request(app).get(SUMMARY);
    expect(unfetched.body.delivery).toBeUndefined();

    git(repo, "fetch", "-q", "origin");
    const fetched = await request(app).get(SUMMARY);
    expect(fetched.body.delivery).toEqual(deliveryOf(twoUnitsIn(), 2));
  });

  it("SB-TC-007: with Pull latest, reads a local commit that origin does not have yet", async () => {
    withOrigin();
    useWorktreeSource(true, true);
    commitRecord("fixture-spec", twoUnitsIn());
    const res = await request(app).get(SUMMARY);
    expect(res.body.delivery).toEqual(deliveryOf(twoUnitsIn(), 2));
  });

  it("SB-TC-007: with Pull latest, names no delivery when the local branch and origin's have diverged", async () => {
    const other = withOrigin();
    useWorktreeSource(true, true);
    // Each side commits a conformant record of its own, so either start would
    // name a delivery. The records differ, so the two commits do too.
    const record = twoUnitsIn();
    commitRecord(
      "fixture-spec",
      { ...record, units: record.units.map((item) => ({ ...item, status: "done" })) },
      other,
    );
    git(other, "push", "-q", "origin", "main");
    commitRecord("fixture-spec", record);
    git(repo, "fetch", "-q", "origin");
    const local = git(repo, "rev-parse", "main").trim();
    const remote = git(repo, "rev-parse", "origin/main").trim();
    expect(local).not.toBe(remote);
    expect(git(repo, "merge-base", local, remote).trim()).not.toMatch(
      new RegExp(`^(${local}|${remote})$`),
    );
    const res = await request(app).get(SUMMARY);
    expect(res.status).toBe(200);
    expect(res.body.delivery).toBeUndefined();
  });

  it("SB-TC-007: names no delivery for a committed record over the size limit", async () => {
    // Valid JSON once parsed, so only the size check leaves the delivery out.
    const folder = path.join(repo, ".specifications", "fixture-spec");
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, DELIVERY_RECORD_FILE);
    fs.writeFileSync(
      file,
      `${JSON.stringify(twoUnitsIn())}${" ".repeat(DELIVERY_RECORD_MAX_BYTES)}`,
    );
    expect(fs.statSync(file).size).toBeGreaterThan(DELIVERY_RECORD_MAX_BYTES);
    git(repo, "add", "--", path.join(".specifications", "fixture-spec", DELIVERY_RECORD_FILE));
    git(repo, "commit", "-q", "-m", "record");
    const res = await request(app).get(SUMMARY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "fixture-spec", units: 0, gates: 0 });
    const loaded = await loadCommittedDeliveryRecord(repo, "HEAD", "fixture-spec");
    expect(loaded.ok ? undefined : loaded.error).toMatchObject({
      code: "DELIVERY_INVALID",
      errors: ["the record is too large"],
    });
  });

  it("answers 0 units and 0 gates for a spec with no work-units.json", async () => {
    fs.mkdirSync(path.join(repo, ".specifications", "bare"), { recursive: true });
    const res = await request(app).get("/api/projects/demo/specbench/specs/bare/summary");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ slug: "bare", units: 0, gates: 0 });
  });

  it("answers 400 for a work-units.json that does not validate", async () => {
    writeWorkUnits("broken", { units: "nope" });
    const res = await request(app).get("/api/projects/demo/specbench/specs/broken/summary");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WORK_UNITS_INVALID");
  });

  it("answers 400 for a slug outside the allowlist", async () => {
    const res = await request(app).get("/api/projects/demo/specbench/specs/..%2Fetc/summary");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_SLUG");
  });

  it("answers 404 for a project that is not registered", async () => {
    vi.mocked(projectRegistry.getProject).mockReturnValue(undefined);
    const res = await request(app).get("/api/projects/nope/specbench/specs/fixture-spec/summary");
    expect(res.status).toBe(404);
  });
});
