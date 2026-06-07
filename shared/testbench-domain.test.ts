import { describe, it, expect } from "vitest";
import { deriveStatus } from "./testbench-domain.js";
import type { Author, ObservationMark } from "./testbench-domain-types.js";

const author: Author = { name: "Dev", email: "dev@example.com" };

function mark(result: "pass" | "fail"): ObservationMark {
  return { result, author, timestamp: "2026-01-01T00:00:00.000Z" };
}

describe("deriveStatus (FR-009 truth table)", () => {
  it("TC-023: no observations marked => not_started", () => {
    expect(deriveStatus(["O1", "O2"], {})).toBe("not_started");
  });

  it("some but not all observations marked => in_progress", () => {
    expect(deriveStatus(["O1", "O2"], { O1: mark("pass") })).toBe("in_progress");
  });

  it("all observations marked AND all pass => passed", () => {
    expect(deriveStatus(["O1", "O2"], { O1: mark("pass"), O2: mark("pass") })).toBe("passed");
  });

  it("TC-026: all observations marked AND at least one fail => failed", () => {
    expect(deriveStatus(["O1", "O2"], { O1: mark("pass"), O2: mark("fail") })).toBe("failed");
  });

  it("all observations marked AND all fail => failed", () => {
    expect(deriveStatus(["O1", "O2"], { O1: mark("fail"), O2: mark("fail") })).toBe("failed");
  });

  it("single observation marked pass => passed", () => {
    expect(deriveStatus(["O1"], { O1: mark("pass") })).toBe("passed");
  });

  it("zero observations defined => not_started (edge)", () => {
    expect(deriveStatus([], {})).toBe("not_started");
  });

  it("ignores marks for observation ids not in the defined set", () => {
    // A stray mark keyed to an unknown id must not count toward the denominator.
    expect(deriveStatus(["O1"], { O1: mark("pass"), OBSOLETE: mark("fail") })).toBe("passed");
  });

  it("never derives blocked (marks are pass|fail only)", () => {
    const results = new Set<string>();
    results.add(deriveStatus([], {}));
    results.add(deriveStatus(["O1"], {}));
    results.add(deriveStatus(["O1", "O2"], { O1: mark("pass") }));
    results.add(deriveStatus(["O1"], { O1: mark("pass") }));
    results.add(deriveStatus(["O1"], { O1: mark("fail") }));
    expect(results.has("blocked")).toBe(false);
  });
});
