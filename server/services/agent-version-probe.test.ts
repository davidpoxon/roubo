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
  invalidateAgentVersionProbe,
  isAtLeast,
  parseVersion,
  probeAgentVersion,
  probeDeclaredAgentVersion,
  resetAgentVersionProbeCache,
  warmAgentVersion,
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

  it("re-probes once the detection has aged past its TTL", async () => {
    vi.useFakeTimers();
    try {
      probeOutput("2.1.100 (Claude Code)");
      const stale = await probeAgentVersion("claude-code", "claude", SPEC);
      expect(stale.status).toBe("below-floor");

      // An agent CLI is updated in place, so the resolved binary (and therefore
      // the cache key) is unchanged. Without expiry the pre-update version would
      // be replayed for the life of the process.
      vi.advanceTimersByTime(61_000);
      probeOutput("2.1.180 (Claude Code)");
      const fresh = await probeAgentVersion("claude-code", "claude", SPEC);

      expect(runCommand).toHaveBeenCalledTimes(2);
      expect(fresh.status).toBe("within-tested-range");
      expect(fresh.detectedVersion).toBe("2.1.180");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still serves the cached detection within the TTL", async () => {
    vi.useFakeTimers();
    try {
      probeOutput("2.1.180 (Claude Code)");
      await probeAgentVersion("claude-code", "claude", SPEC);
      vi.advanceTimersByTime(30_000);
      await probeAgentVersion("claude-code", "claude", SPEC);
      expect(runCommand).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidateAgentVersionProbe forces the next probe to re-spawn", async () => {
    probeOutput("2.1.100 (Claude Code)");
    await probeAgentVersion("claude-code", "claude", SPEC);

    // What the below-floor refusal does, so the guidance ("update the CLI, then
    // launch again") is actually actionable via the panel's Retry action.
    invalidateAgentVersionProbe("claude-code");
    probeOutput("2.1.180 (Claude Code)");
    const result = await probeAgentVersion("claude-code", "claude", SPEC);

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("within-tested-range");
  });
});

describe("probeAgentVersion against the launch's PATH (issue #660)", () => {
  it("resolves AND spawns against the supplied search path, not the server's", async () => {
    probeOutput("2.1.180 (Claude Code)");
    await probeAgentVersion("claude-code", "claude", SPEC, "/opt/agent/bin");

    expect(resolveAgentCommand).toHaveBeenCalledWith("claude", "/opt/agent/bin");
    // Resolution alone is not enough: a bare name comes back unchanged, so the
    // exec would otherwise look it up on the server's PATH all over again.
    expect(vi.mocked(runCommand).mock.calls[0][3]).toEqual({ PATH: "/opt/agent/bin" });
  });

  it("defaults to the server's PATH when no search path is supplied", async () => {
    probeOutput("2.1.180 (Claude Code)");
    await probeAgentVersion("claude-code", "claude", SPEC);

    expect(resolveAgentCommand).toHaveBeenCalledWith("claude", process.env.PATH);
  });

  it("does not share one bare-name detection across two different search paths", async () => {
    probeOutput("2.1.180 (Claude Code)");
    const first = await probeAgentVersion("claude-code", "claude", SPEC, "/opt/a/bin");
    probeOutput("2.1.100 (Claude Code)");
    const second = await probeAgentVersion("other-agent", "claude", SPEC, "/opt/b/bin");

    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(first.detectedVersion).toBe("2.1.180");
    expect(second.detectedVersion).toBe("2.1.100");
  });

  it("still shares one detection for a path-shaped binary whatever the search path", async () => {
    probeOutput("2.1.180 (Claude Code)");
    await probeAgentVersion("claude-code", "/opt/a/bin/claude", SPEC, "/opt/a/bin");
    await probeAgentVersion("other-agent", "/opt/a/bin/claude", SPEC, "/opt/b/bin");

    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("reports probe-failed for a templated search path (AP-TC-074)", async () => {
    const result = await probeAgentVersion("claude-code", "claude", SPEC, "{{workspacePath}}/bin");

    expect(result.status).toBe("probe-failed");
    expect(result.reason).toContain("templated");
    expect(resolveAgentCommand).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe("probeDeclaredAgentVersion and warmAgentVersion", () => {
  const DECLARED = {
    minVersion: "2.1.111",
    testedCeiling: "2.1.205",
    probe: { command: "claude", args: ["--version"], parse: "semver" as const },
  };

  it("probes from the manifest alone, with no launch descriptor (AP-TC-113)", async () => {
    probeOutput("2.1.180 (Claude Code)");
    const result = await probeDeclaredAgentVersion("claude-code", DECLARED);
    expect(result?.status).toBe("within-tested-range");
    expect(result?.detectedVersion).toBe("2.1.180");
    expect(vi.mocked(runCommand).mock.calls[0][0]).toBe("claude");
  });

  it("carries the manifest's declared bounds into the verdict (AP-TC-114)", async () => {
    probeOutput("2.1.207 (Claude Code)");
    const result = await probeDeclaredAgentVersion("claude-code", DECLARED);
    expect(result?.status).toBe("above-tested-ceiling");
    expect(result?.testedCeiling).toBe("2.1.205");
  });

  it("resolves undefined and spawns nothing when the manifest declares no probe", async () => {
    expect(
      await probeDeclaredAgentVersion("claude-code", { minVersion: "2.1.111" }),
    ).toBeUndefined();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("warms the cache so the card shows a detected version without a launch (AP-TC-113)", async () => {
    probeOutput("2.1.180 (Claude Code)");
    warmAgentVersion("claude-code", DECLARED);
    await vi.waitFor(() => expect(getCachedAgentVersion("claude-code")).toBeDefined());

    expect(buildCompatibilityState("claude-code", DECLARED)).toMatchObject({
      detectedVersion: "2.1.180",
      status: "within-tested-range",
    });
  });

  it("does not stack a spawn per call while a warm is in flight or already cached", async () => {
    probeOutput("2.1.180 (Claude Code)");
    warmAgentVersion("claude-code", DECLARED);
    warmAgentVersion("claude-code", DECLARED);
    await vi.waitFor(() => expect(getCachedAgentVersion("claude-code")).toBeDefined());
    warmAgentVersion("claude-code", DECLARED);

    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a manifest that declares no probe", () => {
    warmAgentVersion("claude-code", { minVersion: "2.1.111" });
    expect(runCommand).not.toHaveBeenCalled();
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
