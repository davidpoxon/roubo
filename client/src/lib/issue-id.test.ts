import { describe, it, expect } from "vitest";
import {
  issueNumberFromExternalId,
  isAlertExternalId,
  shortIdFromExternalId,
  displayIssueRef,
} from "./issue-id";

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

  it("returns null for an alert externalId", () => {
    expect(issueNumberFromExternalId("org/repo#code-scanning-117")).toBeNull();
  });
});

describe("isAlertExternalId", () => {
  it("is true for each alert category", () => {
    expect(isAlertExternalId("org/repo#code-scanning-117")).toBe(true);
    expect(isAlertExternalId("org/repo#secret-scanning-9")).toBe(true);
    expect(isAlertExternalId("org/repo#dependabot-3")).toBe(true);
  });

  it("is false for a plain issue or unknown form", () => {
    expect(isAlertExternalId("org/repo#42")).toBe(false);
    expect(isAlertExternalId("ROUBO-42")).toBe(false);
    expect(isAlertExternalId("org/repo#code-scanning-")).toBe(false);
  });
});

describe("shortIdFromExternalId", () => {
  it("returns the part after # for issues and alerts", () => {
    expect(shortIdFromExternalId("org/repo#42")).toBe("42");
    expect(shortIdFromExternalId("org/repo#code-scanning-117")).toBe("code-scanning-117");
  });

  it("returns the whole value when there is no #", () => {
    expect(shortIdFromExternalId("42")).toBe("42");
  });
});

describe("displayIssueRef", () => {
  it("renders #number for GitHub issues and alerts", () => {
    expect(displayIssueRef({ number: 42, externalId: "42" })).toBe("#42");
    expect(displayIssueRef({ number: 117, externalId: "org/repo#code-scanning-117" })).toBe("#117");
  });

  it("renders the externalId key when there is no number (e.g. Jira)", () => {
    expect(displayIssueRef({ externalId: "PLNRPTGOOG-3782" })).toBe("PLNRPTGOOG-3782");
  });
});
