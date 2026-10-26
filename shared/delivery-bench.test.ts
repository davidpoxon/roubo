import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DELIVERY_RECORD_SECTIONS,
  buildDeliveryLaunchDescriptor,
  checkDeliveryRecord,
  deliveryRoutePaths,
  isDeliveryReadError,
} from "./delivery-bench";
import { DeliveryRecordSchema } from "./delivery-observation-contract";

const FIXTURE = fileURLToPath(new URL("./__fixtures__/delivery-record.json", import.meta.url));

function fixture(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
}

describe("buildDeliveryLaunchDescriptor", () => {
  it("carries eventUrl, controlsUrl and the token as data", () => {
    const descriptor = buildDeliveryLaunchDescriptor({
      origin: "http://localhost:3335/",
      projectId: "demo",
      benchId: 4,
      token: "t0ken",
    });
    expect(descriptor).toEqual({
      eventUrl: "http://localhost:3335/api/projects/demo/benches/4/delivery/events",
      controlsUrl: "http://localhost:3335/api/projects/demo/benches/4/delivery/controls",
      token: "t0ken",
    });
    expect(descriptor).not.toHaveProperty("resume");
  });

  it("carries the resume argument only when one is given", () => {
    const descriptor = buildDeliveryLaunchDescriptor({
      origin: "http://localhost:3335",
      projectId: "demo",
      benchId: 4,
      token: "t0ken",
      resume: "demo-delivery-1",
    });
    expect(descriptor.resume).toBe("demo-delivery-1");
  });

  it("encodes the project id into the paths", () => {
    expect(deliveryRoutePaths("a b", 1).base).toBe("/api/projects/a%20b/benches/1/delivery");
  });

  it("names the launch route beside resume", () => {
    const paths = deliveryRoutePaths("demo", 4);
    expect(paths.launch).toBe("/api/projects/demo/benches/4/delivery/launch");
    expect(paths.resume).toBe("/api/projects/demo/benches/4/delivery/resume");
  });
});

describe("checkDeliveryRecord", () => {
  it("names every required section the record schema has", () => {
    const shapeKeys = Object.keys(DeliveryRecordSchema.shape);
    for (const section of DELIVERY_RECORD_SECTIONS) expect(shapeKeys).toContain(section);
  });

  it("accepts the conformant fixture", () => {
    const check = checkDeliveryRecord(fixture());
    expect(check.ok).toBe(true);
  });

  it("names the missing budget section as DELIVERY_NONCONFORMANT", () => {
    const record = fixture();
    delete record.budget;
    const check = checkDeliveryRecord(record);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error).toMatchObject({
      code: "DELIVERY_NONCONFORMANT",
      section: "budget",
      sections: ["budget"],
    });
    expect(isDeliveryReadError(check.error)).toBe(true);
  });

  it("reports units as an object as a validation error naming units", () => {
    const record = fixture();
    record.units = { A: {} };
    const check = checkDeliveryRecord(record);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error.code).toBe("DELIVERY_INVALID");
    expect(check.error.field).toBe("units");
    expect(check.error.error).toMatch(/units/);
    expect(check.error.errors?.some((e) => e.startsWith("units"))).toBe(true);
  });

  it("reports an unknown contract major version as a version mismatch", () => {
    const check = checkDeliveryRecord({
      ...fixture(),
      $schema: "https://roubo.dev/schema/delivery-record/v2.0.0.json",
      schemaVersion: "2.0.0",
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error).toMatchObject({
      code: "DELIVERY_VERSION_MISMATCH",
      found: "2.0.0",
      supported: "1.0.0",
    });
  });

  it("reports a mismatch when only the schema id carries the other major", () => {
    const check = checkDeliveryRecord({
      ...fixture(),
      $schema: "https://roubo.dev/schema/delivery-record/v3.1.0.json",
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.error.code).toBe("DELIVERY_VERSION_MISMATCH");
  });

  it("reads a later minor of the same major as the version it knows", () => {
    const check = checkDeliveryRecord({
      ...fixture(),
      $schema: "https://roubo.dev/schema/delivery-record/v1.2.0.json",
      schemaVersion: "1.2.0",
      added_in_a_minor: { kept: true },
    });
    expect(check.ok).toBe(true);
  });

  it("checks the version before the sections, and the sections before the fields", () => {
    const record = fixture();
    delete record.units;
    record.schemaVersion = "2.0.0";
    const mismatch = checkDeliveryRecord(record);
    expect(!mismatch.ok && mismatch.error.code).toBe("DELIVERY_VERSION_MISMATCH");

    const missing = fixture();
    delete missing.lifecycle;
    missing.units = "not a list";
    const nonconformant = checkDeliveryRecord(missing);
    expect(!nonconformant.ok && nonconformant.error.section).toBe("lifecycle");
  });

  it("refuses a document that is not an object", () => {
    for (const raw of [null, [], "record", 3]) {
      const check = checkDeliveryRecord(raw);
      expect(!check.ok && check.error.code).toBe("DELIVERY_INVALID");
    }
  });
});
