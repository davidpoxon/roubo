import { describe, it, expect } from "vitest";
import { detectExtraFields, KNOWN_TOP_LEVEL_KEYS } from "./detectExtraFields";

describe("detectExtraFields", () => {
  it("returns empty array for null/undefined", () => {
    expect(detectExtraFields(null)).toEqual([]);
    expect(detectExtraFields(undefined)).toEqual([]);
  });

  it("returns empty array for non-object input", () => {
    expect(detectExtraFields("string")).toEqual([]);
    expect(detectExtraFields(42)).toEqual([]);
    expect(detectExtraFields([])).toEqual([]);
  });

  it("returns empty array when all keys are known", () => {
    const config = {
      project: { name: "test" },
      layout: { type: "single-repo" },
      components: {},
      ports: {},
      tools: [],
      inspection: null,
      benches: { max: 5 },
      jigs: [],
      users: [],
    };
    expect(detectExtraFields(config)).toEqual([]);
  });

  it("returns unknown key when one extra field is present", () => {
    const config = { project: { name: "test" }, foo: "bar" };
    expect(detectExtraFields(config)).toEqual(["foo"]);
  });

  it("returns all unknown keys when multiple extra fields are present", () => {
    const config = { project: {}, unknown1: true, unknown2: 42 };
    const result = detectExtraFields(config);
    expect(result).toHaveLength(2);
    expect(result).toContain("unknown1");
    expect(result).toContain("unknown2");
  });

  it("returns empty array for empty object", () => {
    expect(detectExtraFields({})).toEqual([]);
  });

  it("known keys constant covers all RouboConfig top-level fields", () => {
    const expected = [
      "project",
      "layout",
      "components",
      "ports",
      "tools",
      "inspection",
      "benches",
      "jigs",
      "users",
    ];
    for (const key of expected) {
      expect(KNOWN_TOP_LEVEL_KEYS.has(key)).toBe(true);
    }
  });
});
