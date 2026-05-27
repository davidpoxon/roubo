import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  resolveWithin,
  isInside,
  assertSafeIdentifier,
  UnsafePathError,
  PLUGIN_ID_RE,
  UUID_RE,
  PROJECT_ID_RE,
  JIG_ID_RE,
} from "./safe-path.js";

const ROOT = path.resolve("/tmp/safe-path-test-root");

describe("resolveWithin", () => {
  it("returns a resolved path inside root for clean segments", () => {
    expect(resolveWithin(ROOT, "a", "b.txt")).toBe(path.join(ROOT, "a", "b.txt"));
  });

  it("returns root itself when no segments are provided", () => {
    expect(resolveWithin(ROOT)).toBe(ROOT);
  });

  it("throws for traversal via ..", () => {
    expect(() => resolveWithin(ROOT, "..", "etc")).toThrow(UnsafePathError);
  });

  it("throws for absolute segment that escapes root", () => {
    expect(() => resolveWithin(ROOT, "/etc/passwd")).toThrow(UnsafePathError);
  });

  it("throws for segment containing a null byte", () => {
    expect(() => resolveWithin(ROOT, "a\0b")).toThrow(UnsafePathError);
  });

  it("throws for empty or invalid root", () => {
    expect(() => resolveWithin("")).toThrow(UnsafePathError);
    expect(() => resolveWithin(undefined as unknown as string)).toThrow(UnsafePathError);
  });

  it("throws for non-string segment", () => {
    expect(() => resolveWithin(ROOT, 123 as unknown as string)).toThrow(UnsafePathError);
  });

  it("allows nested-then-back path that stays inside root", () => {
    expect(resolveWithin(ROOT, "a", "..", "b")).toBe(path.join(ROOT, "b"));
  });
});

describe("isInside", () => {
  it("returns true for paths inside the root", () => {
    expect(isInside(ROOT, path.join(ROOT, "x"))).toBe(true);
  });

  it("returns true for the root itself", () => {
    expect(isInside(ROOT, ROOT)).toBe(true);
  });

  it("returns false for paths outside the root", () => {
    expect(isInside(ROOT, "/etc")).toBe(false);
  });
});

describe("assertSafeIdentifier", () => {
  it("accepts strings matching the pattern", () => {
    expect(() => assertSafeIdentifier("abc-123", PLUGIN_ID_RE, "pluginId")).not.toThrow();
  });

  it("rejects strings that don't match", () => {
    expect(() => assertSafeIdentifier("../etc", PLUGIN_ID_RE, "pluginId")).toThrow(UnsafePathError);
    expect(() => assertSafeIdentifier("Abc", PLUGIN_ID_RE, "pluginId")).toThrow(UnsafePathError);
  });

  it("rejects non-strings", () => {
    expect(() => assertSafeIdentifier(undefined, PLUGIN_ID_RE, "pluginId")).toThrow(
      UnsafePathError,
    );
    expect(() => assertSafeIdentifier(42, PLUGIN_ID_RE, "pluginId")).toThrow(UnsafePathError);
  });
});

describe("identifier regexes", () => {
  it("PLUGIN_ID_RE", () => {
    expect(PLUGIN_ID_RE.test("github-com")).toBe(true);
    expect(PLUGIN_ID_RE.test("a")).toBe(true);
    expect(PLUGIN_ID_RE.test("1abc")).toBe(false);
    expect(PLUGIN_ID_RE.test("ab/cd")).toBe(false);
    expect(PLUGIN_ID_RE.test("..")).toBe(false);
  });

  it("UUID_RE", () => {
    expect(UUID_RE.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(UUID_RE.test("550E8400-E29B-41D4-A716-446655440000")).toBe(false);
    expect(UUID_RE.test("not-a-uuid")).toBe(false);
  });

  it("PROJECT_ID_RE", () => {
    expect(PROJECT_ID_RE.test("roubo")).toBe(true);
    expect(PROJECT_ID_RE.test("my-project_1.0")).toBe(true);
    expect(PROJECT_ID_RE.test("..")).toBe(false);
    expect(PROJECT_ID_RE.test("a/b")).toBe(false);
    expect(PROJECT_ID_RE.test("")).toBe(false);
  });

  it("JIG_ID_RE", () => {
    expect(JIG_ID_RE.test("default-jig")).toBe(true);
    expect(JIG_ID_RE.test("test-123")).toBe(true);
    expect(JIG_ID_RE.test("1st-thing")).toBe(true);
    expect(JIG_ID_RE.test("my_jig")).toBe(true);
    expect(JIG_ID_RE.test("Bad")).toBe(false);
    expect(JIG_ID_RE.test("has space")).toBe(false);
    expect(JIG_ID_RE.test("..")).toBe(false);
    expect(JIG_ID_RE.test("")).toBe(false);
  });
});
