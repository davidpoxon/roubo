import { describe, it, expect } from "vitest";
import {
  belowFloorFailure,
  captureOutput,
  classifyLaunchExit,
  classifyPtyExit,
  compatibilityNotice,
  hostInstallBrokenFailure,
  missingBinaryFailure,
  stripAnsi,
  type AgentLaunchContextInfo,
} from "./agent-launch-failure.js";

const CTX: AgentLaunchContextInfo = {
  agentPluginId: "claude-code",
  agentName: "Claude Code",
  command: "claude",
};

describe("classifyPtyExit (launch-failure spike AC2)", () => {
  it("classifies the codex unknown-flag exit as a launch failure (S5)", () => {
    expect(classifyPtyExit({ exitCode: 2, timeToExitMs: 52, outputBytes: 278 })).toBe(
      "launch-failure",
    );
  });

  it("classifies the claude unknown-flag exit as a launch failure (S4)", () => {
    expect(classifyPtyExit({ exitCode: 1, timeToExitMs: 112, outputBytes: 59 })).toBe(
      "launch-failure",
    );
  });

  it("does NOT classify a fast clean --version exit as a failure (S6)", () => {
    expect(classifyPtyExit({ exitCode: 0, timeToExitMs: 48, outputBytes: 23 })).toBe(
      "fast-clean-exit",
    );
  });

  it("does NOT classify a session that dies at 6s as a launch failure (S7)", () => {
    expect(classifyPtyExit({ exitCode: 3, timeToExitMs: 6019, outputBytes: 0 })).toBe(
      "session-ended",
    );
  });

  it("classifies a nonzero exit with zero output as missing-binary (S2)", () => {
    expect(classifyPtyExit({ exitCode: 1, timeToExitMs: 6, outputBytes: 0 })).toBe(
      "missing-binary",
    );
  });

  it("classifies a shell 127 with its command-not-found line as missing-binary (S3)", () => {
    // The three-signal rule alone would call this a launch failure, because the
    // shell arm does print to the stream. 127 is the classic command-not-found
    // exit, so it is read as the missing binary it is.
    expect(classifyPtyExit({ exitCode: 127, timeToExitMs: 11, outputBytes: 30 })).toBe(
      "missing-binary",
    );
  });

  it("treats a clean exit as clean however slow it was", () => {
    expect(classifyPtyExit({ exitCode: 0, timeToExitMs: 9000, outputBytes: 500 })).toBe(
      "session-ended",
    );
  });

  it("honours a caller-supplied window", () => {
    expect(
      classifyPtyExit({ exitCode: 1, timeToExitMs: 3000, outputBytes: 10, windowMs: 1000 }),
    ).toBe("session-ended");
  });
});

describe("stripAnsi / captureOutput", () => {
  it("removes CSI colour sequences", () => {
    expect(stripAnsi("[31merror: bad flag[0m")).toBe("error: bad flag");
  });

  it("removes OSC title sequences", () => {
    expect(stripAnsi("]0;titleafter")).toBe("after");
  });

  it("normalises CRLF and trims", () => {
    expect(captureOutput("\r\n  error: unexpected argument '--yolo-mode' found  \r\n")).toBe(
      "error: unexpected argument '--yolo-mode' found",
    );
  });

  it("returns undefined when the agent said nothing", () => {
    expect(captureOutput("[2J\r\n   ")).toBeUndefined();
  });

  it("truncates a very large capture", () => {
    const captured = captureOutput("x".repeat(10_000));
    expect(captured?.endsWith("... (truncated)")).toBe(true);
    expect(captured?.length ?? 0).toBeLessThan(10_000);
  });
});

describe("classifyLaunchExit", () => {
  it("surfaces the captured stderr as the error body (AP-TC-075, AP-TC-077)", () => {
    const failure = classifyLaunchExit(CTX, {
      exitCode: 2,
      timeToExitMs: 400,
      output: "[31merror: unexpected argument '--yolo-mode' found[0m",
    });
    expect(failure?.class).toBe("launch-failure");
    expect(failure?.capturedOutput).toBe("error: unexpected argument '--yolo-mode' found");
    expect(failure?.message).toContain("0.4s");
    expect(failure?.actions).toEqual(["open-plugin-settings", "retry"]);
  });

  it("attributes an above-ceiling failure to a probably-stale argument map", () => {
    const failure = classifyLaunchExit(
      {
        ...CTX,
        compatibility: {
          status: "above-tested-ceiling",
          detectedVersion: "2.1.207",
          testedCeiling: "2.1.205",
        },
      },
      { exitCode: 1, timeToExitMs: 112, output: "error: unknown option '--effort'" },
    );
    expect(failure?.guidance).toContain("2.1.205");
    expect(failure?.guidance).toContain("stale");
  });

  it("words a zero-output early exit as a missing binary, not as bad flags (AP-TC-058)", () => {
    const failure = classifyLaunchExit(CTX, { exitCode: 1, timeToExitMs: 6, output: "" });
    expect(failure?.class).toBe("missing-binary");
    expect(failure?.message).toContain("not found");
    expect(failure?.capturedOutput).toBeUndefined();
  });

  it("returns nothing for an exit that was not a launch failure", () => {
    expect(
      classifyLaunchExit(CTX, { exitCode: 0, timeToExitMs: 48, output: "2.1.207" }),
    ).toBeUndefined();
    expect(
      classifyLaunchExit(CTX, { exitCode: 3, timeToExitMs: 6019, output: "" }),
    ).toBeUndefined();
  });
});

describe("failure wording", () => {
  it("names the detected version, the floor and the update action (AP-TC-071)", () => {
    const failure = belowFloorFailure(CTX, {
      status: "below-floor",
      detectedVersion: "2.1.100",
      minVersion: "2.1.111",
    });
    expect(failure.class).toBe("below-floor-version");
    expect(failure.message).toContain("2.1.100");
    expect(failure.message).toContain("2.1.111");
    expect(failure.guidance).toContain("Update");
    expect(failure.actions).toContain("retry");
  });

  it("attributes a spawn throw to the host rather than to the plugin", () => {
    const failure = hostInstallBrokenFailure(CTX, "posix_spawnp failed.");
    expect(failure.class).toBe("host-install-broken");
    expect(failure.message).toContain("Roubo");
    expect(failure.actions).toEqual(["retry"]);
  });

  it("gives a missing binary an install next step", () => {
    const failure = missingBinaryFailure(CTX, "Tried: /usr/bin/claude");
    expect(failure.guidance).toContain("Install");
    expect(failure.actions).toContain("open-plugin-settings");
  });
});

// APCC-NFR-003: the install and update steps an agent plugin declares in its manifest
// `agentInstallGuidance`. APCC-TC-036 and APCC-TC-054 S001-O03 each require the
// message to say HOW, which the generic sentence alone never did.
describe("declared install and update guidance (APCC-NFR-003)", () => {
  const GUIDED: AgentLaunchContextInfo = {
    agentPluginId: "cursor-cli",
    agentName: "Cursor CLI",
    command: "agent",
    installGuidance: {
      install: {
        command: "curl https://cursor.com/install -fsS | bash",
        url: "https://cursor.com/docs/cli/installation",
      },
      update: { command: "agent update" },
    },
  };
  const BELOW = {
    status: "below-floor",
    detectedVersion: "2026.09.01",
    minVersion: "2026.09.08",
  } as const;

  it("APCC-TC-036 S001-O03: a missing CLI names the declared install command and link", () => {
    const failure = missingBinaryFailure(GUIDED, "Tried: ~/.local/bin/agent.");
    expect(failure.guidance).toBe(
      "Install the agent CLI by running `curl https://cursor.com/install -fsS | bash` " +
        "(see https://cursor.com/docs/cli/installation), or point Cursor CLI at an existing " +
        "install from its plugin settings. Tried: ~/.local/bin/agent.",
    );
    expect(failure.remedy).toEqual(GUIDED.installGuidance?.install);
  });

  it("APCC-TC-036 S001-O02: the message still names the missing command", () => {
    const failure = missingBinaryFailure(GUIDED, "Tried: ~/.local/bin/agent.");
    expect(failure.class).toBe("missing-binary");
    expect(failure.message).toBe('Cursor CLI could not start: the "agent" CLI was not found.');
    expect(failure.actions).toEqual(["open-plugin-settings", "retry"]);
  });

  it("APCC-TC-036: a child that exits as unrunnable carries the same install step", () => {
    const failure = classifyLaunchExit(GUIDED, { exitCode: 127, timeToExitMs: 6, output: "" });
    expect(failure?.class).toBe("missing-binary");
    expect(failure?.guidance).toContain("`curl https://cursor.com/install -fsS | bash`");
    expect(failure?.remedy).toEqual(GUIDED.installGuidance?.install);
  });

  it("APCC-TC-054 S001-O03: a CLI below the floor names the declared update command", () => {
    const failure = belowFloorFailure(GUIDED, BELOW);
    expect(failure.guidance).toBe(
      "Update the agent CLI to 2026.09.08 or newer by running `agent update`, then launch " +
        "again. Nothing was started, so no session is running.",
    );
    expect(failure.remedy).toEqual({ command: "agent update" });
  });

  it("APCC-TC-054 S001-O02: the message still names both versions", () => {
    const failure = belowFloorFailure(GUIDED, BELOW);
    expect(failure.class).toBe("below-floor-version");
    expect(failure.message).toBe(
      "Cursor CLI requires CLI version 2026.09.08 or newer, but 2026.09.01 is installed.",
    );
    expect(failure.detectedVersion).toBe("2026.09.01");
    expect(failure.minVersion).toBe("2026.09.08");
  });

  it("a step with only a url reads as a link to follow", () => {
    const failure = belowFloorFailure(
      { ...GUIDED, installGuidance: { update: { url: "https://example.com/update" } } },
      BELOW,
    );
    expect(failure.guidance).toContain(
      "to 2026.09.08 or newer by following https://example.com/update, then launch again.",
    );
    expect(failure.remedy).toEqual({ url: "https://example.com/update" });
  });

  it("each step falls back on its own: an install-only plugin keeps the generic update text", () => {
    const failure = belowFloorFailure(
      { ...GUIDED, installGuidance: { install: { command: "acme-installer" } } },
      BELOW,
    );
    expect(failure.guidance).toBe(
      "Update the agent CLI to 2026.09.08 or newer, then launch again. Nothing was started, so no session is running.",
    );
    expect(failure).not.toHaveProperty("remedy");
  });

  it("a plugin that declares nothing keeps today's generic wording exactly", () => {
    const missing = missingBinaryFailure(CTX, "Tried: /usr/bin/claude");
    expect(missing.guidance).toBe(
      "Install the agent CLI, or point Claude Code at an existing install from its plugin settings. Tried: /usr/bin/claude",
    );
    expect(missing).not.toHaveProperty("remedy");
    const below = belowFloorFailure(CTX, {
      status: "below-floor",
      detectedVersion: "2.1.100",
      minVersion: "2.1.111",
    });
    expect(below.guidance).toBe(
      "Update the agent CLI to 2.1.111 or newer, then launch again. Nothing was started, so no session is running.",
    );
    expect(below).not.toHaveProperty("remedy");
  });
});

describe("compatibilityNotice", () => {
  it("says nothing for an in-range launch (AP-TC-070)", () => {
    expect(
      compatibilityNotice("Claude Code", {
        status: "within-tested-range",
        detectedVersion: "2.1.180",
      }),
    ).toBeUndefined();
  });

  it("warns above the ceiling without implying the launch was blocked (AP-TC-072)", () => {
    const notice = compatibilityNotice("Claude Code", {
      status: "above-tested-ceiling",
      detectedVersion: "2.1.207",
      testedCeiling: "2.1.205",
    });
    expect(notice).toContain("2.1.207");
    expect(notice).toContain("2.1.205");
    expect(notice).toContain("Launching anyway");
  });

  it("says the check did not run when the probe failed (AP-TC-074)", () => {
    const notice = compatibilityNotice("Claude Code", {
      status: "probe-failed",
      reason: "no recognisable version number",
    });
    expect(notice).toContain("could not be determined");
    expect(notice).toContain("no recognisable version number");
  });
});
