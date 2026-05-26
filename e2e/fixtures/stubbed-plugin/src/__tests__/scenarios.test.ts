import { describe, expect, it } from "vitest";
import { loadScenario } from "../scenario.js";

// WU-063: the five scenario packs that back the e2e-flow specs must parse and
// expose the source-picker shape each spec relies on. Catching a typo or
// dropped field here is much cheaper than catching it in a flaky Playwright
// run.
const EXPECTATIONS: Array<{ name: string; shape: "multi-list" | "categorized-multi-list" }> = [
  { name: "github-com-multi-list", shape: "multi-list" },
  { name: "jira-self-hosted-categorized", shape: "categorized-multi-list" },
  { name: "migration-legacy-github", shape: "multi-list" },
  { name: "community-plugin-install", shape: "multi-list" },
  { name: "missing-plugin-prompt", shape: "multi-list" },
];

describe("WU-063 scenario packs", () => {
  for (const { name, shape } of EXPECTATIONS) {
    it(`${name} loads and exposes the ${shape} source-picker shape`, () => {
      const scenario = loadScenario(name);
      expect(scenario.sourceCandidates.shape).toBe(shape);
      expect(scenario.currentUser.externalId).toBeTruthy();
      expect(scenario.connectionStatus.state).toBeTruthy();
      if (shape === "multi-list") {
        expect(Array.isArray(scenario.sourceCandidates.items)).toBe(true);
      } else {
        expect(Array.isArray(scenario.sourceCandidates.categories)).toBe(true);
        expect(scenario.sourceCandidates.categories?.length ?? 0).toBeGreaterThan(0);
      }
    });
  }
});
