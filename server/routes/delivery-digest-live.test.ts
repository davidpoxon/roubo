// The since-you-left digest over the live event path (SB-TC-023, SB-FR-012,
// SB-US-012).
//
// What runs for real: an HTTP server on a loopback port with the delivery
// event route (routes/delivery-hooks.ts) and its body parser, the delivery
// routes (routes/delivery.ts), the delivery token check, the bench's event log
// with its spill file, the record loader over a record in a bench workspace on
// disk, and the shared reducer the digest is derived from. The tooling posts
// events with the token, and the test reads the digest and marks it seen as the
// Delivery tab does.
//
// The bench manager is a stand-in that knows the one Spec Bench, the state
// file write is a stand-in, and the session launcher, the gate pin service and
// the terminals stay out.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import { DELIVERY_EVENT_HOOK_PATH } from "@roubo/shared/delivery-bench";
import type { DeliveryDigest } from "@roubo/shared/delivery-digest";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import type { DeliverySnapshot } from "@roubo/shared/delivery-reducer";

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
  isBenchLive: vi.fn(() => true),
  whenWorkspaceProvisioned: vi.fn(async () => undefined),
}));
vi.mock("../services/state.js", async (importOriginal) => ({
  updateBench: vi.fn(),
  toPersistedBench: (await importOriginal<typeof import("../services/state.js")>())
    .toPersistedBench,
}));
vi.mock("../services/delivery-session-launcher.js", () => ({
  DeliveryLaunchBlockedError: class extends Error {},
  deliveryLaunchBlock: vi.fn(),
  handOutDeliveryToken: vi.fn(),
  launchDeliverySession: vi.fn(),
  whenDeliveryBound: vi.fn(async () => undefined),
}));
vi.mock("../services/gate-pin.js", () => ({
  GatePinError: class extends Error {},
  closeGatePin: vi.fn(),
  openGatePin: vi.fn(),
  openPreparedSitting: vi.fn(),
  prepareGateSitting: vi.fn(async () => undefined),
}));
vi.mock("../services/terminal.js", () => ({
  getSession: vi.fn(),
}));

import * as benchManager from "../services/bench-manager.js";
import * as stateService from "../services/state.js";
import { forgetDeliveryEventLog } from "../services/delivery-event-log.js";
import { benchDeliveryEventSpillPath } from "../lib/delivery-record-loader.js";
import { hashDeliveryToken } from "../services/delivery-token-registry.js";
import { _resetClientsForTest } from "../services/sse.js";
import { makeBench } from "../test/fixtures.js";
import deliveryHooksRouter, { deliveryEventBodyParser } from "./delivery-hooks.js";
import deliveryRouter from "./delivery.js";

const FIXTURE_RECORD = fileURLToPath(
  new URL("../../shared/__fixtures__/delivery-record.json", import.meta.url),
);

const PROJECT_ID = "demo";
const BENCH_ID = 1;
const TOKEN = "delivery-token-for-the-digest";

let tmp: string;
let server: http.Server;
let origin: string;
let bench: Bench;

function fixtureRecord(): DeliveryRecord {
  return JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
}

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  unitId?: string,
): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: fixtureRecord().delivery_id,
    type,
    seq,
    ts: new Date().toISOString(),
    ...(unitId !== undefined && { unit_id: unitId }),
    payload,
  };
}

async function post(events: DeliveryEvent[]): Promise<Response> {
  return fetch(`${origin}${DELIVERY_EVENT_HOOK_PATH}?projectId=${PROJECT_ID}&benchId=${BENCH_ID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ events }),
  });
}

const BASE = () => `${origin}/api/projects/${PROJECT_ID}/benches/${BENCH_ID}/delivery`;

async function readSnapshot(): Promise<DeliverySnapshot> {
  const res = await fetch(BASE());
  expect(res.status).toBe(200);
  return (await res.json()) as DeliverySnapshot;
}

async function readDigest(): Promise<DeliveryDigest> {
  const res = await fetch(`${BASE()}/digest`);
  expect(res.status).toBe(200);
  return (await res.json()) as DeliveryDigest;
}

async function markSeen(body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${BASE()}/digest/seen`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function writeRecord(record: DeliveryRecord): void {
  const specFolder = path.join(tmp, "workspace", ".specifications", "fixture-spec");
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-digest-live-"));
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(path.join(workspace, ".specifications", "fixture-spec"), { recursive: true });
  writeRecord(fixtureRecord());
  bench = makeBench({
    id: BENCH_ID,
    projectId: PROJECT_ID,
    status: "active",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: workspace,
    deliveryBindMode: "launch",
    deliveryTokenHash: hashDeliveryToken(TOKEN),
  });
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  vi.mocked(benchManager.isBenchLive).mockReturnValue(true);
  vi.mocked(stateService.updateBench).mockClear();
  forgetDeliveryEventLog();
  _resetClientsForTest();

  const app = express();
  app.use(DELIVERY_EVENT_HOOK_PATH, deliveryEventBodyParser);
  app.use(express.json({ limit: "210kb" }));
  app.use("/api/hooks", deliveryHooksRouter);
  app.use("/api/projects", deliveryRouter);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _resetClientsForTest();
  forgetDeliveryEventLog();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Since-you-left digest over the live event path", () => {
  it("SB-TC-023 the since-you-left digest summarises changes since the last view, linking each to its unit, decision or gate, and a dismissed digest stays away until new events arrive", async () => {
    // Before the first view the digest lists nothing.
    const first = await readDigest();
    expect(first.lastViewedSeq).toBeNull();
    expect(first.entries).toEqual([]);

    // Step 1: view the bench, then mark it seen.
    const viewed = await readSnapshot();
    const seen = await markSeen();
    expect(seen.status).toBe(204);
    expect(bench.deliveryLastViewedSeq).toBe(viewed.seq);
    expect(vi.mocked(stateService.updateBench)).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: BENCH_ID, deliveryLastViewedSeq: viewed.seq }),
    );

    // Step 2: a unit done, a decision raised and a gate reached, then reopen.
    const next = viewed.seq + 1;
    const accepted = await post([
      event(next, "unit.changed", { status: "done" }, "B"),
      event(next + 1, "decision.raised", {
        decision_id: "decision-3",
        question: "Keep the cache per unit or per stack?",
        options: ["per unit", "per stack"],
        default: "per unit",
        status: "open",
      }),
      event(next + 2, "gate.reached", { gate_id: "gate-after-b" }),
    ]);
    expect(accepted.status).toBe(202);

    const digest = await readDigest();
    expect(digest).toMatchObject({
      lastViewedSeq: viewed.seq,
      seq: next + 2,
      source: "events",
    });
    expect(digest.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      "unit:B",
      "decision:decision-3",
      "gate:gate-after-b",
    ]);
    expect(digest.entries[0]).toMatchObject({
      label: "Second layer",
      status: "done",
      previousStatus: "running",
      events: ["unit.changed"],
    });
    expect(digest.entries[1]).toMatchObject({
      label: "Keep the cache per unit or per stack?",
      previousStatus: null,
      events: ["decision.raised"],
    });
    expect(digest.entries[2]).toMatchObject({ events: ["gate.reached"] });

    // Step 3: dismiss the digest; it lists nothing until new events arrive.
    expect((await markSeen({ seq: digest.seq })).status).toBe(204);
    expect(bench.deliveryLastViewedSeq).toBe(next + 2);
    expect((await readDigest()).entries).toEqual([]);
    expect((await readDigest()).entries).toEqual([]);

    expect((await post([event(next + 3, "unit.changed", { status: "running" }, "C")])).status).toBe(
      202,
    );
    const again = await readDigest();
    expect(again.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["unit:C"]);
  });

  it("SB-TC-023 falls back to the record once the log has rolled past the last view", async () => {
    await readSnapshot();
    expect((await markSeen()).status).toBe(204);
    const viewedSeq = bench.deliveryLastViewedSeq ?? 0;

    // The session folds two events into the record, so they leave the log.
    const record = fixtureRecord();
    const units = record.units.map((unit) =>
      unit.id === "B" ? { ...unit, status: "done" } : unit,
    );
    writeRecord({ ...record, units, last_event_seq: viewedSeq + 2 });
    expect(
      (
        await post([
          event(viewedSeq + 3, "gate.changed", { gate_id: "gate-after-b", status: "passed" }),
        ])
      ).status,
    ).toBe(202);

    const digest = await readDigest();
    expect(digest.source).toBe("record");
    const keys = digest.entries.map((entry) => `${entry.kind}:${entry.id}`);
    // The gate the log still holds an event for, and what awaits the
    // operator; the two rolled events are in no spill file, so the record's B,
    // which moved on without awaiting the operator, is not told apart.
    expect(keys).toEqual([
      "decision:decision-1",
      "decision:decision-2",
      "gate:gate-after-b",
      "gate:gate-after-c",
    ]);
  });

  it("SB-TC-023 reads the rolled events of the spill file once the record has moved past the last view", async () => {
    await readSnapshot();
    expect((await markSeen()).status).toBe(204);
    const viewedSeq = bench.deliveryLastViewedSeq ?? 0;

    // The two events between the last view and the record were spilled
    // before the record folded them in.
    const spillPath = benchDeliveryEventSpillPath(bench);
    const record = fixtureRecord();
    const units = record.units.map((unit) =>
      unit.id === "B" ? { ...unit, status: "done" } : unit,
    );
    writeRecord({ ...record, units, last_event_seq: viewedSeq + 2 });
    fs.writeFileSync(
      spillPath,
      [
        event(viewedSeq + 1, "unit.changed", { status: "done" }, "B"),
        event(viewedSeq + 2, "seam.ran", { seam: "plan", status: "ok" }),
      ]
        .map((spilled) => `${JSON.stringify(spilled)}\n`)
        .join(""),
    );

    const digest = await readDigest();
    expect(digest.source).toBe("record");
    expect(digest.entries.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(["unit:B"]);
  });

  it("SB-TC-023 a last view of an earlier delivery of the bench is no prior view of a new one", async () => {
    bench.deliveryLastViewedSeq = 120;
    bench.deliveryLastViewedDeliveryId = fixtureRecord().delivery_id;
    // The bench's delivery started its seq again, and reached seq 9.
    expect(
      (
        await post([
          event(8, "unit.changed", { status: "done" }, "B"),
          event(9, "seam.ran", { seam: "plan", status: "ok" }),
        ])
      ).status,
    ).toBe(202);
    const restarted = await readDigest();
    expect(restarted).toMatchObject({ lastViewedSeq: null, seq: 9, entries: [] });

    // A record of another delivery replaces the old one, with a seq above the
    // stored view: that view is of the old delivery.
    forgetDeliveryEventLog();
    bench.deliveryLastViewedSeq = 3;
    writeRecord({ ...fixtureRecord(), delivery_id: "demo-delivery-2", last_event_seq: 40 });
    const replaced = await readDigest();
    expect(replaced).toMatchObject({ lastViewedSeq: null, seq: 40, entries: [] });

    // Marking it seen stores the new delivery's id with its seq.
    expect((await markSeen()).status).toBe(204);
    expect(bench.deliveryLastViewedSeq).toBe(40);
    expect(bench.deliveryLastViewedDeliveryId).toBe("demo-delivery-2");
    expect(vi.mocked(stateService.updateBench)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveryLastViewedSeq: 40,
        deliveryLastViewedDeliveryId: "demo-delivery-2",
      }),
    );
  });

  it("SB-TC-023 the digest read and the seen mark answer 409 on a record the bench cannot read", async () => {
    const specFolder = path.join(tmp, "workspace", ".specifications", "fixture-spec");
    fs.rmSync(path.join(specFolder, "delivery-observation.json"));
    const missing = await fetch(`${BASE()}/digest`);
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: "DELIVERY_RECORD_MISSING" });

    fs.writeFileSync(path.join(specFolder, "delivery-observation.json"), "{ not json");
    const unreadable = await fetch(`${BASE()}/digest`);
    expect(unreadable.status).toBe(409);
    const seen = await markSeen();
    expect(seen.status).toBe(409);
    expect(bench.deliveryLastViewedSeq).toBeUndefined();
    expect(vi.mocked(stateService.updateBench)).not.toHaveBeenCalled();
  });

  it("SB-TC-023 refuses a seen seq that is not a non-negative integer, and stores no seq above the current one", async () => {
    const bad = await markSeen({ seq: -1 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "INVALID_BODY", field: "seq" });
    expect(bench.deliveryLastViewedSeq).toBeUndefined();

    const viewed = await readSnapshot();
    expect((await markSeen({ seq: viewed.seq + 50 })).status).toBe(204);
    expect(bench.deliveryLastViewedSeq).toBe(viewed.seq);
  });
});
