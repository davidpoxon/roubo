import { describe, it, expect } from "vitest";
import { deepMergeIntegration } from "./deep-merge.js";
import type { IntegrationConfig } from "./config-schema.js";

describe("deepMergeIntegration", () => {
  it("TC-026: deep-merge with per-field optionality (committed plugin/instance + override sources)", () => {
    const committed: IntegrationConfig = {
      plugin: "jira-self-hosted",
      instance: "https://jira.acme.com",
    };
    const override: Partial<IntegrationConfig> = {
      sources: { boards: [12] },
    };
    expect(deepMergeIntegration(committed, override)).toEqual({
      plugin: "jira-self-hosted",
      instance: "https://jira.acme.com",
      sources: { boards: [12] },
    });
  });

  it("TC-027: array fields REPLACE, not concat", () => {
    const committed: IntegrationConfig = {
      sources: { boards: [12, 34] },
    };
    const override: Partial<IntegrationConfig> = {
      sources: { boards: [99] },
    };
    const result = deepMergeIntegration(committed, override);
    expect(result.sources?.boards).toEqual([99]);
    expect(result.sources?.boards).not.toContain(12);
    expect(result.sources?.boards).not.toContain(34);
  });

  it("TC-065: empty array in override REPLACES non-empty committed array", () => {
    const committed: IntegrationConfig = {
      sources: { boards: [12] },
    };
    const override: Partial<IntegrationConfig> = {
      sources: { boards: [] },
    };
    expect(deepMergeIntegration(committed, override).sources?.boards).toEqual([]);
  });

  it("leaves fields absent from override untouched", () => {
    const committed: IntegrationConfig = {
      plugin: "github-com",
      sources: { repos: ["a/b"] },
    };
    expect(deepMergeIntegration(committed, {})).toEqual(committed);
  });

  it("merges sibling keys inside sources rather than replacing the parent", () => {
    const committed: IntegrationConfig = {
      sources: { boards: [12], repos: ["a/b"] },
    };
    const override: Partial<IntegrationConfig> = {
      sources: { boards: [99] },
    };
    expect(deepMergeIntegration(committed, override)).toEqual({
      sources: { boards: [99], repos: ["a/b"] },
    });
  });

  it("override primitive replaces committed primitive", () => {
    const committed: IntegrationConfig = { plugin: "github-com" };
    const override: Partial<IntegrationConfig> = { plugin: "github-enterprise" };
    expect(deepMergeIntegration(committed, override).plugin).toBe("github-enterprise");
  });

  it("undefined in override falls through to committed value", () => {
    const committed: IntegrationConfig = { plugin: "github-com" };
    const result = deepMergeIntegration(committed, {
      plugin: undefined,
    } as Partial<IntegrationConfig>);
    expect(result.plugin).toBe("github-com");
  });

  it("returns the base shape unchanged when override is empty", () => {
    const committed: IntegrationConfig = {
      plugin: "github-com",
      sources: { repos: ["a/b"] },
    };
    expect(deepMergeIntegration(committed, {})).toEqual(committed);
  });

  it("does not mutate the inputs", () => {
    const committed = { sources: { boards: [1, 2] } };
    const override = { sources: { boards: [9] } };
    const snapshotCommitted = JSON.parse(JSON.stringify(committed));
    const snapshotOverride = JSON.parse(JSON.stringify(override));
    deepMergeIntegration(committed, override);
    expect(committed).toEqual(snapshotCommitted);
    expect(override).toEqual(snapshotOverride);
  });
});
