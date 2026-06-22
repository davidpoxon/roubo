import { describe, it, expect } from "vitest";
import {
  validateGateOverrides,
  emptyGateOverrides,
  GATE_OVERRIDES_SCHEMA_ID,
  GATE_OVERRIDES_SCHEMA_VERSION,
} from "./gate-overrides-contract.js";

function envelope(ops: unknown[], overrides: Record<string, unknown> = {}): unknown {
  return {
    $schema: GATE_OVERRIDES_SCHEMA_ID,
    schemaVersion: GATE_OVERRIDES_SCHEMA_VERSION,
    ops,
    ...overrides,
  };
}

describe("validateGateOverrides", () => {
  it("accepts an empty document", () => {
    const result = validateGateOverrides(emptyGateOverrides());
    expect(result.ok).toBe(true);
  });

  it("accepts a valid merge op", () => {
    const result = validateGateOverrides(
      envelope([{ op: "merge", gateIds: ["WU-001", "WU-002"] }]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.ops).toHaveLength(1);
      expect(result.data.ops[0]).toMatchObject({ op: "merge" });
    }
  });

  it("accepts a valid split op", () => {
    const result = validateGateOverrides(
      envelope([
        {
          op: "split",
          gateId: "WU-001",
          parts: [
            { label: "A", coversWorkUnitIds: ["WU-031"] },
            { label: "B", coversWorkUnitIds: ["WU-032"] },
          ],
        },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a merge op with fewer than two source gates", () => {
    const result = validateGateOverrides(envelope([{ op: "merge", gateIds: ["WU-001"] }]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("gateIds");
    }
  });

  it("rejects a split op with fewer than two parts", () => {
    const result = validateGateOverrides(
      envelope([
        { op: "split", gateId: "WU-001", parts: [{ label: "A", coversWorkUnitIds: ["WU-031"] }] },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("parts");
    }
  });

  it("rejects a split part with no covers ids", () => {
    const result = validateGateOverrides(
      envelope([
        {
          op: "split",
          gateId: "WU-001",
          parts: [
            { label: "A", coversWorkUnitIds: [] },
            { label: "B", coversWorkUnitIds: ["WU-032"] },
          ],
        },
      ]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown op discriminator", () => {
    const result = validateGateOverrides(envelope([{ op: "frobnicate", gateIds: ["a", "b"] }]));
    expect(result.ok).toBe(false);
  });

  it("rejects a wrong $schema", () => {
    const result = validateGateOverrides(
      envelope([], { $schema: "https://example.com/wrong.json" }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects unknown top-level keys (strict)", () => {
    const result = validateGateOverrides(envelope([], { extra: true }));
    expect(result.ok).toBe(false);
  });
});
