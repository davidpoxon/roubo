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

// WU-064: two new scenario packs back the connection-status surfacing and
// auth-problem-flip specs. The flip pack also exercises the new
// `connectionStatusSequence` field; keep the loader assertion here so a
// missing or mistyped pack fails before Playwright spins up.
describe("WU-064 scenario packs", () => {
  it("status-surfacing-three-placements loads with a connected baseline", () => {
    const scenario = loadScenario("status-surfacing-three-placements");
    expect(scenario.connectionStatus.state).toBe("connected");
    expect(scenario.connectionStatusSequence).toBeUndefined();
  });

  it("status-auth-problem-flip loads with a connected→auth-problem sequence", () => {
    const scenario = loadScenario("status-auth-problem-flip");
    expect(scenario.connectionStatusSequence).toBeDefined();
    expect(scenario.connectionStatusSequence?.[0].state).toBe("connected");
    expect(scenario.connectionStatusSequence?.[1].state).toBe("auth-problem");
    expect(scenario.connectionStatusSequence?.[1].detail).toBe("Token expired");
  });
});

// WU-066: two scenario packs back the project-load Enable-plugin prompt
// modal specs (TC-171, TC-172). The greenfield pack keeps the stub healthy
// so the Enable click succeeds; the edges pack carries `failOnStart` so the
// stub exits non-zero on the failure arm.
describe("WU-066 scenario packs", () => {
  it("greenfield-and-enable-prompt loads with a connected baseline and no failOnStart", () => {
    const scenario = loadScenario("greenfield-and-enable-prompt");
    expect(scenario.connectionStatus.state).toBe("connected");
    expect(scenario.sourceCandidates.shape).toBe("multi-list");
    expect(scenario.failOnStart).toBeFalsy();
  });

  it("enable-prompt-edges sets failOnStart: true so plugin-manager surfaces a spawn failure", () => {
    const scenario = loadScenario("enable-prompt-edges");
    expect(scenario.failOnStart).toBe(true);
  });
});

// WU-068: four scenario packs back the per-project Settings specs that drive
// the github-com/ghe/jira-self-hosted overlay stubs (TC-177, TC-178, TC-179,
// TC-182). Each is shaped by the per-spec assertions; the loader sanity
// check here catches typos before Playwright spawns the server.
describe("WU-068 scenario packs", () => {
  it("github-tab-consolidation loads with a connected baseline", () => {
    const scenario = loadScenario("github-tab-consolidation");
    expect(scenario.connectionStatus.state).toBe("connected");
    expect(scenario.sourceCandidates.shape).toBe("multi-list");
  });

  it("connect-configure-button loads with disconnected→connected→auth-problem", () => {
    const scenario = loadScenario("connect-configure-button");
    expect(scenario.connectionStatusSequence).toBeDefined();
    expect(scenario.connectionStatusSequence?.length).toBe(3);
    expect(scenario.connectionStatusSequence?.[0].state).toBe("disconnected");
    expect(scenario.connectionStatusSequence?.[1].state).toBe("connected");
    expect(scenario.connectionStatusSequence?.[2].state).toBe("auth-problem");
  });

  it("ghe-consolidation-parity loads with a connected baseline", () => {
    const scenario = loadScenario("ghe-consolidation-parity");
    expect(scenario.connectionStatus.state).toBe("connected");
  });

  it("tab-propagation loads with a connected baseline", () => {
    const scenario = loadScenario("tab-propagation");
    expect(scenario.connectionStatus.state).toBe("connected");
  });
});
