import { describe, it, expect } from "vitest";
import { parseAlertExternalId, isAlertExternalId } from "./alert-external-id.js";

describe("parseAlertExternalId", () => {
  it("parses each alert category", () => {
    expect(parseAlertExternalId("org/repo#code-scanning-117")).toEqual({
      category: "code-scanning",
      alertNumber: 117,
    });
    expect(parseAlertExternalId("org/repo#secret-scanning-42")).toEqual({
      category: "secret-scanning",
      alertNumber: 42,
    });
    expect(parseAlertExternalId("org/repo#dependabot-7")).toEqual({
      category: "dependabot",
      alertNumber: 7,
    });
  });

  it("returns null for a plain issue externalId", () => {
    expect(parseAlertExternalId("org/repo#42")).toBeNull();
  });

  it("returns null for an unknown category or malformed id", () => {
    expect(parseAlertExternalId("org/repo#scanning-1")).toBeNull();
    expect(parseAlertExternalId("org/repo#code-scanning-")).toBeNull();
    expect(parseAlertExternalId("no-hash")).toBeNull();
  });
});

describe("isAlertExternalId", () => {
  it("is true only for alert externalIds", () => {
    expect(isAlertExternalId("org/repo#code-scanning-1")).toBe(true);
    expect(isAlertExternalId("org/repo#42")).toBe(false);
    expect(isAlertExternalId(undefined)).toBe(false);
    expect(isAlertExternalId(null)).toBe(false);
  });
});
