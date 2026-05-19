import { describe, it, expect } from "vitest";
import { formatIssueBody, formatComments } from "./issue-formatting.js";

describe("formatIssueBody", () => {
  it("returns empty string for null", () => {
    expect(formatIssueBody(null)).toBe("");
  });

  it("returns empty string for empty string", () => {
    expect(formatIssueBody("")).toBe("");
  });

  it("returns body unchanged when under 10000 chars", () => {
    const body = "short body";
    expect(formatIssueBody(body)).toBe(body);
  });

  it("does not truncate body at exactly 10000 chars", () => {
    const body = "a".repeat(10000);
    expect(formatIssueBody(body)).toBe(body);
  });

  it("truncates body over 10000 chars and appends [truncated]", () => {
    const body = "a".repeat(10001);
    const result = formatIssueBody(body);
    expect(result).toHaveLength(10000 + "\n\n[truncated]".length);
    expect(result.endsWith("\n\n[truncated]")).toBe(true);
    expect(result.startsWith("a".repeat(10000))).toBe(true);
  });
});

describe("formatComments", () => {
  it("returns empty string for empty array", () => {
    expect(formatComments([])).toBe("");
  });

  it("returns comments with ## Comments header when <=50 comments", () => {
    const comments = [
      { user: "alice", body: "Hello" },
      { user: "bob", body: "World" },
    ];
    const result = formatComments(comments);
    expect(result).toContain("## Comments\n");
    expect(result).toContain("**alice:**\nHello");
    expect(result).toContain("**bob:**\nWorld");
  });

  it("returns truncation header when >50 comments", () => {
    const comments = Array.from({ length: 55 }, (_, i) => ({
      user: `user${i}`,
      body: `comment ${i}`,
    }));
    const result = formatComments(comments);
    expect(result).toContain("showing last 50 of 55");
    expect(result).not.toContain("user0"); // first 5 should be excluded
    expect(result).toContain("user54"); // last one should be included
  });
});
