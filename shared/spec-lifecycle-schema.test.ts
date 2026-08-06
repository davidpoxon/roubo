import { describe, it, expect } from "vitest";
import {
  validateSpecLifecycle,
  SpecLifecycleRecordSchema,
  SPEC_LIFECYCLE_SCHEMA_ID,
  SPEC_LIFECYCLE_SCHEMA_VERSION,
} from "./spec-lifecycle-schema.js";

describe("validateSpecLifecycle", () => {
  it("accepts an archived-only record", () => {
    const result = validateSpecLifecycle({ archived: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ archived: true });
    }
  });

  it("accepts archived plus a reason", () => {
    const result = validateSpecLifecycle({
      archived: true,
      reason: "Shipped in #212; all issues closed.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.reason).toBe("Shipped in #212; all issues closed.");
    }
  });

  it("accepts archived plus a superseding slug", () => {
    const result = validateSpecLifecycle({
      archived: true,
      supersededBy: "integration-plugins",
      reason: "Folded into the integration-plugins spec.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.supersededBy).toBe("integration-plugins");
    }
  });

  it("rejects archived: false (absence, not false, is how live is recorded)", () => {
    const result = validateSpecLifecycle({ archived: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("archived:"))).toBe(true);
    }
  });

  it("rejects a missing archived flag", () => {
    const result = validateSpecLifecycle({ reason: "no flag" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("archived:"))).toBe(true);
    }
  });

  it("rejects an empty reason", () => {
    const result = validateSpecLifecycle({ archived: true, reason: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("reason:"))).toBe(true);
    }
  });

  it.each([
    ["../escape", "traversal segment"],
    ["nested/slug", "path separator"],
    ["..", "dot-dot"],
    ["Upper-Case", "uppercase"],
    ["", "empty"],
  ])("rejects an unsafe supersededBy pointer %s (%s)", (pointer) => {
    const result = validateSpecLifecycle({ archived: true, supersededBy: pointer });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.startsWith("supersededBy:"))).toBe(true);
    }
  });

  it("rejects an unknown key inside the lifecycle record", () => {
    const result = validateSpecLifecycle({ archived: true, retired: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).not.toHaveLength(0);
    }
  });

  it.each([[null], [undefined], ["archived"], [true], [[]]])(
    "rejects the non-object value %s",
    (value) => {
      expect(validateSpecLifecycle(value).ok).toBe(false);
    },
  );

  it("carries the versioned $id on the root schema", () => {
    expect(SPEC_LIFECYCLE_SCHEMA_ID).toContain(SPEC_LIFECYCLE_SCHEMA_VERSION);
    expect(SpecLifecycleRecordSchema.meta()?.$id).toBe(SPEC_LIFECYCLE_SCHEMA_ID);
  });
});
