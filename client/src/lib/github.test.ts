// @vitest-environment node
import { describe, it, expect } from "vitest";
import { blockerUrl } from "./github";

describe("blockerUrl", () => {
  it("replaces the issue number in a standard GitHub URL", () => {
    expect(blockerUrl("https://github.com/org/repo/issues/42", 10)).toBe(
      "https://github.com/org/repo/issues/10",
    );
  });

  it("handles single-digit issue numbers", () => {
    expect(blockerUrl("https://github.com/org/repo/issues/1", 99)).toBe(
      "https://github.com/org/repo/issues/99",
    );
  });

  it("handles large issue numbers", () => {
    expect(blockerUrl("https://github.com/org/repo/issues/12345", 67890)).toBe(
      "https://github.com/org/repo/issues/67890",
    );
  });
});
