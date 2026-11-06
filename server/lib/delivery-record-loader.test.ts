// The record loader's path handling for a Spec Bench: the record is read from
// `.specifications/<slug>/` inside the bench workspace (SB-FR-002, SB-FR-009).
// Each load of a bench's record prunes its control queue (SB-FR-037).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench, DeliveryOutboxControl } from "@roubo/shared";
import type {
  DeliveryDecision,
  DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";

vi.mock("../services/state.js", async (importOriginal) => ({
  updateBench: vi.fn(),
  toPersistedBench: (await importOriginal<typeof import("../services/state.js")>())
    .toPersistedBench,
}));

import * as stateService from "../services/state.js";
import {
  forgetDeliveryControlMemory,
  issueDeliveryControl,
  readDeliveryControls,
} from "../services/delivery-control-outbox.js";
import { makeBench } from "../test/fixtures.js";
import { deliverySpecFolder, loadBenchDeliveryRecord } from "./delivery-record-loader.js";

let tmp: string;
let workspace: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-record-loader-"));
  workspace = path.join(tmp, "workspace");
  fs.mkdirSync(workspace);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const focusedSpecPath = "/repo/.specifications/fixture-spec";

describe("loadBenchDeliveryRecord", () => {
  it("resolves the spec folder of the slug inside the bench workspace", () => {
    expect(deliverySpecFolder({ workspacePath: workspace, focusedSpecPath })).toBe(
      path.join(workspace, ".specifications", "fixture-spec"),
    );
  });

  it("answers DELIVERY_RECORD_MISSING when the workspace has no spec folder yet", () => {
    expect(fs.existsSync(path.join(workspace, ".specifications"))).toBe(false);
    const loaded = loadBenchDeliveryRecord({ workspacePath: workspace, focusedSpecPath });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("DELIVERY_RECORD_MISSING");
  });

  it("answers DELIVERY_RECORD_MISSING when the workspace itself does not exist yet", () => {
    const loaded = loadBenchDeliveryRecord({
      workspacePath: path.join(tmp, "not-provisioned"),
      focusedSpecPath,
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("DELIVERY_RECORD_MISSING");
  });

  it("refuses a focused spec path whose slug fails the allowlist", () => {
    const loaded = loadBenchDeliveryRecord({
      workspacePath: workspace,
      focusedSpecPath: "/repo/.specifications/Bad Slug",
    });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("DELIVERY_INVALID");
  });

  it("refuses a workspace spec folder that is a symlink out of the workspace", () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(path.join(outside, "fixture-spec"), { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, ".specifications"));
    const loaded = loadBenchDeliveryRecord({ workspacePath: workspace, focusedSpecPath });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.code).toBe("DELIVERY_INVALID");
  });
});

// ── Pruning the control queue against the record (SB-FR-037) ──

const FIXTURE_RECORD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../shared/__fixtures__/delivery-record.json",
);
const OPTIONS = ["one file per unit", "one file per stack"];
const AUTHOR = { name: "Ada Operator", email: "ada@example.test" };

function agentDecision(id: string, review: "unreviewed" | "accepted" | "overturned") {
  return {
    id,
    question: `Which layout for ${id}?`,
    options: OPTIONS,
    default: OPTIONS[0],
    status: "decided",
    unit_id: "B",
    raised_at: "2026-10-16T10:00:00Z",
    author: "agent",
    chosen: OPTIONS[1],
    rationale: `Rationale of ${id}.`,
    affected_units: ["B", "C"],
    review: { status: review },
    decided_at: "2026-10-16T10:00:01Z",
  } satisfies DeliveryDecision;
}

function writeRecord(
  reviews: Record<string, "unreviewed" | "accepted" | "overturned">,
  mode: DeliveryRecord["mode"] = { value: "auto", pending: null },
): void {
  const record = JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
  const folder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(folder, "delivery-observation.json"),
    JSON.stringify({
      ...record,
      mode,
      review: { status: "none", unreviewed: [] },
      decisions: Object.entries(reviews).map(([id, review]) => agentDecision(id, review)),
    }),
  );
}

function specBench(): Bench {
  return makeBench({
    variant: "specbench",
    focusedSpecPath,
    workspacePath: workspace,
  });
}

function issue(
  bench: Bench,
  kind: "review_accept" | "overturn" | "mode_switch",
  targetId: string | undefined,
  body: Record<string, unknown>,
): DeliveryOutboxControl {
  const issued = issueDeliveryControl(bench, {
    deliveryId: "demo-delivery-1",
    kind,
    ...(targetId !== undefined && { targetId }),
    body,
    author: AUTHOR,
    ...(kind !== "mode_switch" && { reviewAction: true }),
  });
  if (!issued.ok) throw new Error(issued.errors.join("; "));
  return issued.control;
}

describe("loadBenchDeliveryRecord prunes the control queue", () => {
  beforeEach(() => {
    forgetDeliveryControlMemory();
    vi.mocked(stateService.updateBench).mockClear();
  });

  it("SB-TC-091 keeps a delivered accept until the record shows its decision accepted", () => {
    writeRecord({ "D-1": "unreviewed" });
    const bench = specBench();
    const accept = issue(bench, "review_accept", "D-1", {});
    expect(readDeliveryControls(bench, 0).controls).toMatchObject([
      { control_seq: accept.control_seq, status: "delivered" },
    ]);
    vi.mocked(stateService.updateBench).mockClear();

    // Delivery alone clears nothing.
    expect(loadBenchDeliveryRecord(bench).ok).toBe(true);
    expect(bench.deliveryControlQueue).toMatchObject([
      { control_seq: accept.control_seq, kind: "review_accept", status: "delivered" },
    ]);
    expect(stateService.updateBench).not.toHaveBeenCalled();

    // The record shows D-1 accepted: the load clears the accept and saves the bench.
    writeRecord({ "D-1": "accepted" });
    expect(loadBenchDeliveryRecord(bench).ok).toBe(true);
    expect(bench.deliveryControlQueue).toEqual([]);
    const saved = vi.mocked(stateService.updateBench).mock.calls.at(-1)?.[0];
    expect(saved?.deliveryControlQueue).toEqual([]);
    // The seq goes on from the last one issued.
    expect(saved?.deliveryControlSeq).toBe(accept.control_seq);
  });

  it("SB-TC-090 clears each review action and mode switch whose effect the record shows, and keeps the rest", () => {
    writeRecord({ "D-1": "unreviewed", "D-2": "unreviewed", "D-3": "unreviewed" });
    const bench = specBench();
    issue(bench, "review_accept", "D-1", {});
    const overturn = issue(bench, "overturn", "D-2", { option: OPTIONS[0] });
    const acceptThree = issue(bench, "review_accept", "D-3", {});
    const toAttended = issue(bench, "mode_switch", undefined, { mode: "attended" });

    // The record shows none of them yet.
    loadBenchDeliveryRecord(bench);
    expect(bench.deliveryControlQueue?.map((c) => c.control_seq)).toEqual([1, 2, 3, 4]);

    // D-1 accepted, D-3 overturned by the session, the mode switch on its way.
    writeRecord(
      { "D-1": "accepted", "D-2": "unreviewed", "D-3": "overturned" },
      { value: "auto", pending: "attended" },
    );
    loadBenchDeliveryRecord(bench);
    expect(bench.deliveryControlQueue).toMatchObject([
      { control_seq: overturn.control_seq, kind: "overturn", status: "pending" },
      { control_seq: acceptThree.control_seq, kind: "review_accept", status: "superseded" },
      { control_seq: toAttended.control_seq, kind: "mode_switch", status: "pending" },
    ]);

    // D-2 overturned and the mode attended: only the superseded accept stays.
    writeRecord(
      { "D-1": "accepted", "D-2": "overturned", "D-3": "overturned" },
      { value: "attended", pending: null },
    );
    loadBenchDeliveryRecord(bench);
    expect(bench.deliveryControlQueue).toMatchObject([
      { control_seq: acceptThree.control_seq, status: "superseded" },
    ]);
    // A later control still takes a seq above every earlier one.
    expect(issue(bench, "review_accept", "D-1", {}).control_seq).toBe(5);
  });

  it("clears a mode switch that a later one the record shows overtook, and keeps one it does not show", () => {
    writeRecord({});
    const bench = specBench();
    issue(bench, "mode_switch", undefined, { mode: "attended" });
    issue(bench, "mode_switch", undefined, { mode: "auto" });
    // The record still states auto, the mode of the last switch: the switch to
    // attended was overtaken, so both go.
    loadBenchDeliveryRecord(bench);
    expect(bench.deliveryControlQueue).toEqual([]);

    issue(bench, "mode_switch", undefined, { mode: "attended" });
    loadBenchDeliveryRecord(bench);
    expect(bench.deliveryControlQueue).toMatchObject([{ kind: "mode_switch", control_seq: 3 }]);
  });

  it("prunes nothing when given only the paths of a bench", () => {
    writeRecord({ "D-1": "accepted" });
    expect(loadBenchDeliveryRecord({ workspacePath: workspace, focusedSpecPath }).ok).toBe(true);
    expect(stateService.updateBench).not.toHaveBeenCalled();
  });
});
