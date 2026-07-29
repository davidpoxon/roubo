import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./exec.js");
vi.mock("./env.js", () => ({
  resolveAgentCommand: vi.fn((command: string) => command),
  AgentCommandNotFoundError: class AgentCommandNotFoundError extends Error {
    constructor(
      public readonly command: string,
      public readonly tried: string[],
    ) {
      super(`Agent CLI "${command}" was not found. Tried: ${tried.join(", ")}`);
      this.name = "AgentCommandNotFoundError";
    }
  },
}));

import type { VersionProbeSpec } from "@roubo/shared/agent-launch-descriptor-schema";
import { runCommand } from "./exec.js";
import { AgentCommandNotFoundError, resolveAgentCommand } from "./env.js";
import {
  buildCompatibilityState,
  classifyVersion,
  compareVersions,
  getCachedAgentVersion,
  isAtLeast,
  parseVersion,
  probeAgentVersion,
  resetAgentVersionProbeCache,
} from "./agent-version-probe.js";

const SPEC: VersionProbeSpec = {
  args: ["--version"],
  parse: "semver",
  minVersion: "2.1.111",
  testedCeiling: "2.1.205",
};

function probeOutput(stdout: string, code = 0) {
  vi.mocked(runCommand).mockResolvedValue({ code, stdout, stderr: "" });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentVersionProbeCache();
  vi.mocked(resolveAgentCommand).mockImplementation((command: string) => command);
});

describe("parseVersion", () => {
  it("reads the semver out of both agents' --version formats (spike #504 AC3)", () => {
    expect(parseVersion("2.1.207 (Claude Code)")).toBe("2.1.207");
    expect(parseVersion("codex-cli 0.144.1")).toBe("0.144.1");
  });

  it("returns null when the output carries no version", () => {
    expect(parseVersion("command not found")).toBeNull();
  });
});

describe("compareVersions / isAtLeast", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("2.1.207", "2.1.205")).toBeGreaterThan(0);
    expect(compareVersions("2.0.999", "2.1.0")).toBeLessThan(0);
    expect(compareVersions("10.0.0", "9.9.9")).toBeGreaterThan(0);
    expect(compareVersions("2.1.111", "2.1.111")).toBe(0);
  });

  it("treats the floor as inclusive (AP-TC-073)", () => {
    expect(isAtLeast("2.1.111", "2.1.111")).toBe(true);
    expect(isAtLeast("2.1.110", "2.1.111")).toBe(false);
  });
});

describe("classifyVersion", () => {
  it("reports within-tested-range between the bounds (AP-TC-070)", () => {
    expect(classifyVersion("2.1.180", SPEC).status).toBe("within-tested-range");
  });

  it("reports below-floor under the floor (AP-TC-071)", () => {
    const result = classifyVersion("2.1.100", SPEC);
    expect(result.status).toBe("below-floor");
    expect(result.detectedVersion).toBe("2.1.100");
    expect(result.minVersion).toBe("2.1.111");
  });

  it("reports above-tested-ceiling over the ceiling (AP-TC-072)", () => {
    expect(classifyVersion("2.1.207", SPEC).status).toBe("above-tested-ceiling");
  });

  it("treats the floor and the ceiling as inclusive (AP-TC-073)", () => {
    expect(classifyVersion("2.1.111", SPEC).status).toBe("within-tested-range");
    expect(classifyVersion("2.1.205", SPEC).status).toBe("within-tested-range");
  });

  it("cannot block when no floor is declared", () => {
    expect(classifyVersion("0.0.1", { args: ["--version"], parse: "semver" }).status).toBe(
      "within-tested-range",
    );
  });
});

describe("probeAgentVersion", () => {
  it("spawns the declared probe args and classifies the result", async () => {
    probeOutput("2.1.180 (Claude Code)");
    const result = await probeAgentVersion("claude-code", "claude", SPEC);
    expect(result.status).toBe("within-tested-range");
    expect(result.detectedVersion).toBe("2.1.180");
    expect(vi.mocked(runCommand).mock.calls[0][0]).toBe("claude");
    expect(vi.mocked(runCommand).mock.calls[0][1]).toEqual(["--version"]);
  });

  it("caches per resolved binary so a second launch does not spawn again", async () => {
    probeOutput("2.1.180 (Claude Code)");
    await probeAgentVersion("claude-code", "claude", SPEC);
    await probeAgentVersion("claude-code", "claude", SPEC);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the cache is reset", async () => {
    probeOutput("2.1.180 (Claude Code)");
    await probeAgentVersion("claude-code", "claude", SPEC);
    resetAgentVersionProbeCache();
    await probeAgentVersion("claude-code", "claude", SPEC);
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("reports probe-failed with a reason on unparseable output (AP-TC-074)", async () => {
    probeOutput("this build has no version number");
    const result = await probeAgentVersion("claude-code", "claude", SPEC);
    expect(result.status).toBe("probe-failed");
    expect(result.reason).toContain("no recognisable version");
    expect(result.minVersion).toBe("2.1.111");
  });

  it("reports probe-failed with the exit detail on a nonzero probe exit", async () => {
    vi.mocked(runCommand).mockResolvedValue({ code: 127, stdout: "", stderr: "not found" });
    const result = await probeAgentVersion("claude-code", "claude", SPEC);
    expect(result.status).toBe("probe-failed");
    expect(result.reason).toContain("127");
  });

  it("reports probe-failed rather than throwing when the binary resolves nowhere", async () => {
    vi.mocked(resolveAgentCommand).mockImplementation(() => {
      throw new AgentCommandNotFoundError("claude", ["/usr/bin/claude"]);
    });
    const result = await probeAgentVersion("claude-code", "claude", SPEC);
    expect(result.status).toBe("probe-failed");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("does not probe a templated command", async () => {
    const result = await probeAgentVersion("claude-code", "{{workspace}}/claude", SPEC);
    expect(result.status).toBe("probe-failed");
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("getCachedAgentVersion / buildCompatibilityState", () => {
  it("returns nothing for a plugin that has never been probed", () => {
    expect(getCachedAgentVersion("claude-code")).toBeUndefined();
  });

  it("reads back the last probe without spawning again", async () => {
    probeOutput("2.1.207 (Claude Code)");
    await probeAgentVersion("claude-code", "claude", SPEC);
    vi.mocked(runCommand).mockClear();

    expect(getCachedAgentVersion("claude-code")?.status).toBe("above-tested-ceiling");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("renders the manifest window with status unknown before any probe (AP-TC-113)", () => {
    const state = buildCompatibilityState("claude-code", {
      minVersion: "2.1.111",
      testedCeiling: "2.1.205",
    });
    expect(state).toEqual({
      minVersion: "2.1.111",
      testedCeiling: "2.1.205",
      status: "unknown",
    });
  });

  it("merges the detected version and verdict once a probe has run (AP-TC-114)", async () => {
    probeOutput("2.1.207 (Claude Code)");
    await probeAgentVersion("claude-code", "claude", SPEC);

    const state = buildCompatibilityState("claude-code", {
      minVersion: "2.1.111",
      testedCeiling: "2.1.205",
    });
    expect(state).toMatchObject({
      detectedVersion: "2.1.207",
      testedCeiling: "2.1.205",
      status: "above-tested-ceiling",
    });
  });

  it("returns undefined when nothing is declared and nothing was probed", () => {
    expect(buildCompatibilityState("claude-code", undefined)).toBeUndefined();
  });
});
