import { describe, it, expect } from "vitest";
import { deriveDuplicateName } from "./duplicateBlueprintName";

describe("deriveDuplicateName", () => {
  it('returns "<name> (copy)" when there are no existing names', () => {
    expect(deriveDuplicateName("Foo", [])).toBe("Foo (copy)");
  });

  it('strips existing "(copy)" suffix and re-adds it', () => {
    expect(deriveDuplicateName("Foo (copy)", [])).toBe("Foo (copy)");
  });

  it('strips existing "(copy N)" suffix and uses base', () => {
    expect(deriveDuplicateName("Foo (copy 3)", [])).toBe("Foo (copy)");
  });

  it("increments to (copy 2) when (copy) is taken", () => {
    expect(deriveDuplicateName("Foo", ["Foo (copy)"])).toBe("Foo (copy 2)");
  });

  it("increments to (copy 4) when (copy), (copy 2), (copy 3) are taken", () => {
    expect(deriveDuplicateName("Foo", ["Foo (copy)", "Foo (copy 2)", "Foo (copy 3)"])).toBe(
      "Foo (copy 4)",
    );
  });

  it("handles case-insensitive collisions", () => {
    expect(deriveDuplicateName("Foo", ["FOO (COPY)"])).toBe("Foo (copy 2)");
  });

  it("truncates a long base to keep the candidate within 100 chars", () => {
    const longName = "A".repeat(98);
    const result = deriveDuplicateName(longName, []);
    // suffix " (copy)" = 7 chars; base should be trimmed to 93
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith(" (copy)")).toBe(true);
  });

  it("truncates further for (copy 2) when the (copy) form is also taken", () => {
    const longName = "A".repeat(98);
    // Pre-build the (copy) candidate to add as existing
    const copySuffix = " (copy)";
    const copyCandidate = longName.slice(0, 100 - copySuffix.length).trimEnd() + copySuffix;
    const result = deriveDuplicateName(longName, [copyCandidate]);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result.endsWith(" (copy 2)")).toBe(true);
  });

  it('does not match "(copying)" as a copy suffix', () => {
    expect(deriveDuplicateName("Foo (copying)", [])).toBe("Foo (copying) (copy)");
  });

  it("trims whitespace from the original name", () => {
    expect(deriveDuplicateName("  Foo  ", [])).toBe("Foo (copy)");
  });

  it("strips suffix with extra spaces around it", () => {
    // "Foo  (copy)" — extra space before suffix
    expect(deriveDuplicateName("Foo  (copy)", [])).toBe("Foo (copy)");
  });
});
