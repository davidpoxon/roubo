import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./project-registry.js", () => ({
  resolveEnforceIssueDependencies: vi.fn(),
}));

vi.mock("./plugin-manager.js", () => ({
  invoke: vi.fn(),
}));

import { assertGateOpen, fetchIssueForStart } from "./start-gate.js";
import * as projectRegistry from "./project-registry.js";
import * as pluginManager from "./plugin-manager.js";
import { ServiceError } from "./service-error.js";
import type { NormalizedIssue } from "@roubo/shared";

function makeIssue(blockedBy: string[]): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId: "owner/repo#42",
    externalUrl: "https://example/42",
    title: "Some unit",
    body: null,
    currentState: "open",
    allowedTransitions: [],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy,
    updatedAt: "2026-01-01T00:00:00Z",
    raw: {},
  };
}

describe("assertGateOpen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns immediately and issues no RPC when enforcement is OFF", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(false);

    await expect(assertGateOpen("proj", "owner/repo#42", "github-com")).resolves.toBeUndefined();

    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("returns immediately when explicit enforce=false is passed (no registry lookup, no RPC)", async () => {
    await expect(
      assertGateOpen("proj", "owner/repo#42", "github-com", { enforce: false }),
    ).resolves.toBeUndefined();

    expect(projectRegistry.resolveEnforceIssueDependencies).not.toHaveBeenCalled();
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("ON + unblocked: resolves and allows the start", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(pluginManager.invoke).mockResolvedValue(makeIssue([]) as never);

    await expect(assertGateOpen("proj", "owner/repo#42", "github-com")).resolves.toBeUndefined();

    expect(pluginManager.invoke).toHaveBeenCalledOnce();
  });

  it("ON + blocked: throws 409 GATE_BLOCKED naming every blocker", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(pluginManager.invoke).mockResolvedValue(
      makeIssue(["owner/repo#10", "owner/repo#11"]) as never,
    );

    const err = await assertGateOpen("proj", "owner/repo#42", "github-com").catch((e) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect(err.statusCode).toBe(409);
    expect(err.data).toMatchObject({
      code: "GATE_BLOCKED",
      blockedBy: ["owner/repo#10", "owner/repo#11"],
    });
    expect(err.message).toContain("owner/repo#10");
    expect(err.message).toContain("owner/repo#11");
  });

  it("ON + no active plugin and no prefetched issue: throws 409 GATE_INDETERMINATE", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);

    const err = await assertGateOpen("proj", "owner/repo#42", undefined).catch((e) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect(err.statusCode).toBe(409);
    expect(err.data).toMatchObject({ code: "GATE_INDETERMINATE" });
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("ON + RPC error: throws 409 GATE_INDETERMINATE (fail-closed)", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("network down"));

    const err = await assertGateOpen("proj", "owner/repo#42", "github-com").catch((e) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect(err.statusCode).toBe(409);
    expect(err.data).toMatchObject({ code: "GATE_INDETERMINATE" });
  });

  it("ON + RPC timeout: throws 409 GATE_INDETERMINATE (fail-closed)", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
      // A getIssue that never settles must be bounded by the 3s timer.
      vi.mocked(pluginManager.invoke).mockReturnValue(new Promise<never>(() => {}));

      const pending = assertGateOpen("proj", "owner/repo#42", "github-com", {
        timeoutMs: 3000,
      });
      const settled = pending.then(
        () => ({ ok: true }) as const,
        (e) => ({ ok: false, err: e }) as const,
      );

      await vi.advanceTimersByTimeAsync(3000);
      const outcome = await settled;

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.err).toBeInstanceOf(ServiceError);
        expect(outcome.err.statusCode).toBe(409);
        expect(outcome.err.data).toMatchObject({ code: "GATE_INDETERMINATE" });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses a prefetched issue and issues no getIssue RPC", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);

    await expect(
      assertGateOpen("proj", "owner/repo#42", "github-com", {
        prefetchedIssue: makeIssue([]),
      }),
    ).resolves.toBeUndefined();

    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("blocks from a prefetched issue without any RPC", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);

    const err = await assertGateOpen("proj", "owner/repo#42", "github-com", {
      prefetchedIssue: makeIssue(["owner/repo#9"]),
    }).catch((e) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect(err.data).toMatchObject({ code: "GATE_BLOCKED", blockedBy: ["owner/repo#9"] });
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });
});

describe("fetchIssueForStart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OFF: reads the issue with a plain getIssue RPC and returns the full issue", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(false);
    const issue = makeIssue(["owner/repo#7"]);
    vi.mocked(pluginManager.invoke).mockResolvedValue(issue as never);

    await expect(fetchIssueForStart("proj", "owner/repo#42", "github-com")).resolves.toBe(issue);

    expect(pluginManager.invoke).toHaveBeenCalledOnce();
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "owner/repo#42",
    });
  });

  it("ON + resolves: returns the full issue from a single bounded getIssue RPC", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    const issue = makeIssue([]);
    vi.mocked(pluginManager.invoke).mockResolvedValue(issue as never);

    await expect(fetchIssueForStart("proj", "owner/repo#42", "github-com")).resolves.toBe(issue);

    expect(pluginManager.invoke).toHaveBeenCalledOnce();
    expect(pluginManager.invoke).toHaveBeenCalledWith("github-com", "getIssue", {
      externalId: "owner/repo#42",
    });
  });

  it("ON + hung getIssue: fails closed with 409 GATE_INDETERMINATE in ~3s, exactly one RPC", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
      // A getIssue that never settles must be bounded by the 3s gate timer, not
      // the plugin manager's 30s RPC default (#438, NFR-002).
      vi.mocked(pluginManager.invoke).mockReturnValue(new Promise<never>(() => {}));

      const pending = fetchIssueForStart("proj", "owner/repo#42", "github-com");
      const settled = pending.then(
        () => ({ ok: true }) as const,
        (e) => ({ ok: false, err: e }) as const,
      );

      await vi.advanceTimersByTimeAsync(3000);
      const outcome = await settled;

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.err).toBeInstanceOf(ServiceError);
        expect(outcome.err.statusCode).toBe(409);
        expect(outcome.err.data).toMatchObject({ code: "GATE_INDETERMINATE" });
      }
      // Exactly one getIssue RPC per start request (NFR-002, the one-RPC half).
      expect(pluginManager.invoke).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ON + RPC error: fails closed with 409 GATE_INDETERMINATE", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);
    vi.mocked(pluginManager.invoke).mockRejectedValue(new Error("network down"));

    const err = await fetchIssueForStart("proj", "owner/repo#42", "github-com").catch((e) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect(err.statusCode).toBe(409);
    expect(err.data).toMatchObject({ code: "GATE_INDETERMINATE" });
  });

  it("ON + no active plugin: fails closed with 409 GATE_INDETERMINATE and issues no RPC", async () => {
    vi.mocked(projectRegistry.resolveEnforceIssueDependencies).mockReturnValue(true);

    const err = await fetchIssueForStart("proj", "owner/repo#42", undefined).catch((e) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect(err.statusCode).toBe(409);
    expect(err.data).toMatchObject({ code: "GATE_INDETERMINATE" });
    expect(pluginManager.invoke).not.toHaveBeenCalled();
  });

  it("honours an explicit enforce=true without consulting the registry", async () => {
    const issue = makeIssue([]);
    vi.mocked(pluginManager.invoke).mockResolvedValue(issue as never);

    await expect(
      fetchIssueForStart("proj", "owner/repo#42", "github-com", { enforce: true }),
    ).resolves.toBe(issue);

    expect(projectRegistry.resolveEnforceIssueDependencies).not.toHaveBeenCalled();
    expect(pluginManager.invoke).toHaveBeenCalledOnce();
  });
});
