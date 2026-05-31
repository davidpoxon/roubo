import { describe, it, expect, afterEach } from "vitest";
import {
  deriveInstanceHost,
  setInstanceHost,
  getInstanceHost,
  clearInstanceRegistry,
} from "./plugin-instance-registry.js";

afterEach(() => {
  clearInstanceRegistry();
});

describe("deriveInstanceHost", () => {
  it("returns the lowercased host (incl. port) for a valid instance URL", () => {
    expect(deriveInstanceHost("https://Jira.Acme.Example")).toBe("jira.acme.example");
    expect(deriveInstanceHost("https://jira.acme.example:8443/context")).toBe(
      "jira.acme.example:8443",
    );
  });

  it("returns null for empty, non-string, or unparseable instances", () => {
    expect(deriveInstanceHost("")).toBeNull();
    expect(deriveInstanceHost(undefined)).toBeNull();
    expect(deriveInstanceHost(null)).toBeNull();
    expect(deriveInstanceHost(42)).toBeNull();
    expect(deriveInstanceHost("not a url")).toBeNull();
  });
});

describe("plugin-instance-registry", () => {
  it("returns null for an unknown plugin", () => {
    expect(getInstanceHost("never-activated")).toBeNull();
  });

  it("stores and reads back a host", () => {
    setInstanceHost("jira-self-hosted", "jira.acme.example");
    expect(getInstanceHost("jira-self-hosted")).toBe("jira.acme.example");
  });

  it("overwrites a prior host, including clearing it to null", () => {
    setInstanceHost("ghe", "ghe.acme.example");
    expect(getInstanceHost("ghe")).toBe("ghe.acme.example");
    setInstanceHost("ghe", "ghe.new.example");
    expect(getInstanceHost("ghe")).toBe("ghe.new.example");
    setInstanceHost("ghe", null);
    expect(getInstanceHost("ghe")).toBeNull();
  });

  it("clearInstanceRegistry drops all entries", () => {
    setInstanceHost("a", "a.example");
    setInstanceHost("b", "b.example");
    clearInstanceRegistry();
    expect(getInstanceHost("a")).toBeNull();
    expect(getInstanceHost("b")).toBeNull();
  });
});
