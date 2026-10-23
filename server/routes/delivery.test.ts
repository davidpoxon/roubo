// The delivery read routes of a Spec Bench, over the record fixture
// (SB-FR-008, SB-FR-009, SB-FR-013): GET /delivery folds the record and the
// accepted events into a snapshot, and GET /delivery/events answers the
// accepted events above a seq, for one unit or all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import { DELIVERY_EVENT_SPILL_FILE } from "@roubo/shared/delivery-bench";

vi.mock("../services/bench-manager.js", () => ({
  getBench: vi.fn(),
  whenWorkspaceProvisioned: vi.fn(async () => undefined),
}));

// The read routes launch nothing; the launcher is mocked so its own
// collaborators (terminals, the token registry) stay out of this file.
vi.mock("../services/delivery-session-launcher.js", () => ({
  DeliveryLaunchBlockedError: class extends Error {},
  deliveryLaunchBlock: vi.fn(),
  handOutDeliveryToken: vi.fn(),
  launchDeliverySession: vi.fn(),
  whenDeliveryBound: vi.fn(async () => undefined),
}));

import * as benchManager from "../services/bench-manager.js";
import { forgetDeliveryEventLog, ingestDeliveryEvents } from "../services/delivery-event-log.js";
import router from "./delivery.js";

const FIXTURE_RECORD = fileURLToPath(
  new URL("../../shared/__fixtures__/delivery-record.json", import.meta.url),
);

function fixtureRecord(): DeliveryRecord {
  return JSON.parse(fs.readFileSync(FIXTURE_RECORD, "utf8")) as DeliveryRecord;
}

function recordWithout(section: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fixtureRecord()).filter(([key]) => key !== section));
}

let tmp: string;
let specFolder: string;
let bench: Bench;
let app: express.Express;

function writeRecord(record: unknown): void {
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

function event(seq: number, unitId: string | undefined, status = "running"): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "demo-delivery-1",
    type: "unit.changed",
    seq,
    ts: "2026-10-16T09:40:00Z",
    ...(unitId !== undefined && { unit_id: unitId }),
    payload: { status },
  };
}

// Accepts events through the bench's event log, as the ingest route does.
function accept(events: DeliveryEvent[]): void {
  const result = ingestDeliveryEvents(
    bench.projectId,
    bench.id,
    fixtureRecord(),
    events,
    path.join(specFolder, DELIVERY_EVENT_SPILL_FILE),
  );
  expect(result.ok).toBe(true);
}

const base = "/api/projects/demo/benches/1/delivery";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-routes-"));
  const workspace = path.join(tmp, "workspace");
  specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  bench = {
    id: 1,
    projectId: "demo",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: workspace,
  } as Bench;
  vi.mocked(benchManager.getBench).mockImplementation((projectId, benchId) =>
    projectId === bench.projectId && benchId === bench.id ? bench : undefined,
  );
  forgetDeliveryEventLog();
  app = express();
  app.use("/api/projects", router);
});

afterEach(() => {
  forgetDeliveryEventLog();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("GET /:projectId/benches/:id/delivery", () => {
  it("answers 200 with the snapshot folded from the record and the accepted events", async () => {
    writeRecord(fixtureRecord());
    accept([event(8, "C"), event(9, "D", "done")]);

    const res = await request(app).get(base);

    expect(res.status).toBe(200);
    expect(res.body.deliveryId).toBe("demo-delivery-1");
    expect(res.body.seq).toBe(9);
    expect(res.body.unitsById.C.status).toBe("running");
    expect(res.body.unitsById.D.status).toBe("done");
    expect(res.body.gap).toBeUndefined();
  });

  it("answers 404 NOT_SPEC_BENCH for a bench that is not a Spec Bench", async () => {
    bench = { ...bench, variant: "default" } as Bench;
    writeRecord(fixtureRecord());

    const res = await request(app).get(base);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_SPEC_BENCH" });
    expect(typeof res.body.error).toBe("string");
  });

  it("answers 404 NOT_FOUND for a bench that does not exist", async () => {
    const res = await request(app).get("/api/projects/demo/benches/2/delivery");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 409 DELIVERY_NONCONFORMANT naming the missing section", async () => {
    writeRecord(recordWithout("budget"));

    const res = await request(app).get(base);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_NONCONFORMANT", section: "budget" });
  });

  it("answers 409 DELIVERY_RECORD_MISSING while the workspace has no record", async () => {
    const res = await request(app).get(base);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_RECORD_MISSING" });
  });
});

describe("GET /:projectId/benches/:id/delivery/events", () => {
  it("answers every accepted event above the record with the accepted seq", async () => {
    writeRecord(fixtureRecord());
    accept([event(8, "C"), event(9, "D"), event(10, undefined)]);

    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(200);
    expect(res.body.acceptedSeq).toBe(10);
    expect(res.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([8, 9, 10]);
  });

  it("answers the accepted seq of the record when no event was accepted yet", async () => {
    writeRecord(fixtureRecord());

    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], acceptedSeq: 7 });
  });

  it("filters to the unit by the envelope unit_id, in seq order", async () => {
    writeRecord(fixtureRecord());
    accept([event(8, "C"), event(9, "D"), event(10, "C", "done"), event(11, undefined)]);

    const res = await request(app).get(`${base}/events?unit=C`);

    expect(res.status).toBe(200);
    expect(res.body.acceptedSeq).toBe(11);
    expect(res.body.events.map((e: DeliveryEvent) => [e.seq, e.unit_id])).toEqual([
      [8, "C"],
      [10, "C"],
    ]);
  });

  it("honours after, alone and with unit", async () => {
    writeRecord(fixtureRecord());
    accept([event(8, "C"), event(9, "D"), event(10, "C"), event(11, "C")]);

    const above = await request(app).get(`${base}/events?after=9`);
    expect(above.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([10, 11]);

    const unitAbove = await request(app).get(`${base}/events?after=10&unit=C`);
    expect(unitAbove.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([11]);
    expect(unitAbove.body.acceptedSeq).toBe(11);

    const none = await request(app).get(`${base}/events?after=11`);
    expect(none.body).toEqual({ events: [], acceptedSeq: 11 });
  });

  it("reads the spill file as well as memory, in seq order", async () => {
    writeRecord(fixtureRecord());
    fs.writeFileSync(
      path.join(specFolder, DELIVERY_EVENT_SPILL_FILE),
      `${JSON.stringify(event(8, "C"))}\n${JSON.stringify(event(9, "D"))}\n`,
    );
    // The log holds nothing in memory yet: the read seeds it from the record.
    const res = await request(app).get(`${base}/events?unit=C`);

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: DeliveryEvent) => e.seq)).toEqual([8]);
  });

  it.each(["-1", "1.5", "abc", ""])("answers 400 INVALID_QUERY for after=%s", async (after) => {
    writeRecord(fixtureRecord());

    const res = await request(app).get(`${base}/events?after=${after}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_QUERY", field: "after" });
    expect(typeof res.body.error).toBe("string");
  });

  it("answers 400 INVALID_QUERY for a unit given twice", async () => {
    writeRecord(fixtureRecord());

    const res = await request(app).get(`${base}/events?unit=C&unit=D`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "INVALID_QUERY", field: "unit" });
  });

  it("answers 404 NOT_SPEC_BENCH for a bench that is not a Spec Bench", async () => {
    bench = { ...bench, variant: "default" } as Bench;
    writeRecord(fixtureRecord());

    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_SPEC_BENCH" });
  });

  it("answers 409 DELIVERY_NONCONFORMANT naming the missing section", async () => {
    writeRecord(recordWithout("lifecycle"));

    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_NONCONFORMANT", section: "lifecycle" });
  });

  it("answers 409 DELIVERY_RECORD_MISSING while the workspace has no record", async () => {
    const res = await request(app).get(`${base}/events`);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "DELIVERY_RECORD_MISSING" });
  });
});
