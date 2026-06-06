import { describe, it, expect } from "vitest";
import {
  TargetSchema,
  TestbenchTargetingSpikeSchema,
  TESTBENCH_TARGETING_SCHEMA_ID,
  type Target,
} from "./testbench-targeting-schema.js";

describe("TESTBENCH_TARGETING_SCHEMA_ID", () => {
  it("is the semver-versioned spike $id", () => {
    expect(TESTBENCH_TARGETING_SCHEMA_ID).toBe(
      "https://roubo.dev/schema/testbench-targeting.spike/v0.1.0.json",
    );
  });
});

describe("TargetSchema: each targeting strategy", () => {
  const valid: Target[] = [
    { kind: "css", selector: "#submit" },
    { kind: "role", role: "button", name: "Save" },
    { kind: "text", text: "Continue" },
    { kind: "text", text: "Continue", exact: true },
    { kind: "route", path: "/settings/testbench" },
    { kind: "region", region: "main" },
  ];

  it.each(valid)("accepts a valid %o target", (target) => {
    expect(TargetSchema.safeParse(target).success).toBe(true);
  });

  it("rejects an unknown discriminant kind", () => {
    const result = TargetSchema.safeParse({ kind: "xpath", selector: "//button" });
    expect(result.success).toBe(false);
  });

  it("rejects a member missing a required field", () => {
    expect(TargetSchema.safeParse({ kind: "role", role: "button" }).success).toBe(false);
  });

  it("rejects an empty selector (min length 1)", () => {
    expect(TargetSchema.safeParse({ kind: "css", selector: "" }).success).toBe(false);
  });

  it("rejects unknown keys on a member (strict)", () => {
    expect(TargetSchema.safeParse({ kind: "css", selector: "#x", extra: true }).success).toBe(
      false,
    );
  });
});

describe("TestbenchTargetingSpikeSchema", () => {
  it("accepts steps and observations with the optional targets omitted", () => {
    const result = TestbenchTargetingSpikeSchema.safeParse({
      steps: [{ instruction: "Open settings" }],
      observations: [{ prompt: "The TestBench tab is visible" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts steps and observations carrying targeting selectors", () => {
    const result = TestbenchTargetingSpikeSchema.safeParse({
      steps: [
        { instruction: "Click save", target: { kind: "role", role: "button", name: "Save" } },
      ],
      observations: [{ prompt: "A toast appears", observe: { kind: "text", text: "Saved" } }],
    });
    expect(result.success).toBe(true);
  });

  it("requires steps and observations arrays", () => {
    expect(TestbenchTargetingSpikeSchema.safeParse({ steps: [] }).success).toBe(false);
  });

  it("rejects an unknown top-level key (strict)", () => {
    expect(
      TestbenchTargetingSpikeSchema.safeParse({
        steps: [],
        observations: [],
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects an invalid embedded target", () => {
    expect(
      TestbenchTargetingSpikeSchema.safeParse({
        steps: [{ instruction: "x", target: { kind: "css", selector: "" } }],
        observations: [],
      }).success,
    ).toBe(false);
  });
});
