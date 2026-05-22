import { describe, it, expect } from "vitest";
import { issueNumberFromExternalId } from "./issue-id";

describe("issueNumberFromExternalId", () => {
  it("extracts the trailing number from a repo#number externalId", () => {
    expect(issueNumberFromExternalId("org/repo#123")).toBe(123);
  });

  it("extracts a pure-number externalId", () => {
    expect(issueNumberFromExternalId("42")).toBe(42);
  });

  it("returns null for a Jira-style key", () => {
    expect(issueNumberFromExternalId("ROUBO-42")).toBeNull();
  });

  it("returns null when the suffix is non-numeric", () => {
    expect(issueNumberFromExternalId("repo#abc")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(issueNumberFromExternalId("")).toBeNull();
  });

  it("returns null when the number has leading zeros (round-trip mismatch)", () => {
    expect(issueNumberFromExternalId("repo#007")).toBeNull();
  });
});
