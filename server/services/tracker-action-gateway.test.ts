import { describe, it, expect, vi } from "vitest";
import {
  TrackerActionAuditLog,
  TrackerActionError,
  addBlockedBy,
  closeGate,
  createIssue,
  type TrackerActionGatewayDeps,
} from "./tracker-action-gateway.js";
import type { VerifyUnit } from "../lib/gate-evaluator.js";
import type { CreateIssueResult } from "@roubo/plugin-sdk";
import type { Tracker } from "@roubo/shared/work-units-contract";

const PROJECT = "proj-1";
const PLUGIN = "github-com";

function makeGate(trackerRef: string | null = "o/r#451"): VerifyUnit {
  const tracker: Tracker | undefined =
    trackerRef === null
      ? undefined
      : { system: "github", ref: trackerRef, url: "https://x", blocked_by_refs: [] };
  return {
    id: "WU-040",
    title: "Verify gate",
    type: "task",
    kind: "verify",
    description: "Gate",
    acceptance_criteria: [],
    depends_on: [],
    covers: [],
    implements: { requirement_ids: [], user_story_ids: [], test_case_ids: ["TC-001"] },
    ...(tracker ? { tracker } : {}),
  };
}

// A deps factory with everything consented + capable by default; each test
// overrides only the seam it exercises.
function makeDeps(overrides: Partial<TrackerActionGatewayDeps> = {}): {
  deps: TrackerActionGatewayDeps;
  audit: TrackerActionAuditLog;
  invoke: ReturnType<typeof vi.fn>;
  onGatePassed: ReturnType<typeof vi.fn>;
} {
  const audit = new TrackerActionAuditLog();
  const invoke = vi.fn();
  const onGatePassed = vi.fn(async () => undefined);
  const deps: TrackerActionGatewayDeps = {
    invoke: invoke as unknown as TrackerActionGatewayDeps["invoke"],
    resolveActivePlugin: () => ({ pluginId: PLUGIN, integrationId: PLUGIN, pageSize: 50 }),
    getCapabilities: () => ({ supportsCreateIssue: true, supportsBlockingLinks: true }),
    hasConsent: () => true,
    onGatePassed: onGatePassed as unknown as TrackerActionGatewayDeps["onGatePassed"],
    recordAudit: (entry) => audit.record(entry),
    now: () => "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  return { deps, audit, invoke, onGatePassed };
}

describe("TrackerActionGateway: consented + declared success (TC-047)", () => {
  it("createIssue invokes the plugin and records an 'applied' audit entry", async () => {
    const { deps, audit, invoke } = makeDeps();
    const created: CreateIssueResult = {
      ref: "o/r#99",
      url: "https://github.com/o/r/issues/99",
      nodeId: "N99",
    };
    invoke.mockResolvedValueOnce(created);

    const result = await createIssue(
      PROJECT,
      { repoFullName: "o/r", title: "Fix the gate", body: "b", labels: ["bug"] },
      deps,
    );

    expect(result).toEqual(created);
    expect(invoke).toHaveBeenCalledWith(PLUGIN, "createIssue", {
      repoFullName: "o/r",
      title: "Fix the gate",
      body: "b",
      labels: ["bug"],
    });
    const entries = audit.query({ projectId: PROJECT });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "createIssue",
      outcome: "applied",
      pluginId: PLUGIN,
      refs: { repoFullName: "o/r", title: "Fix the gate", ref: "o/r#99" },
    });
  });

  it("addBlockedBy invokes the plugin and records an 'applied' audit entry", async () => {
    const { deps, audit, invoke } = makeDeps();
    invoke.mockResolvedValueOnce(undefined);

    await addBlockedBy(PROJECT, { blockedRef: "o/r#10", blockerRef: "o/r#11" }, deps);

    expect(invoke).toHaveBeenCalledWith(PLUGIN, "addBlockedBy", {
      blockedRef: "o/r#10",
      blockerRef: "o/r#11",
    });
    const entries = audit.query();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: "addBlockedBy", outcome: "applied" });
  });

  it("closeGate delegates to onGatePassed and records an 'applied' audit entry", async () => {
    const { deps, audit, onGatePassed } = makeDeps();
    const gate = makeGate("o/r#451");

    await closeGate(PROJECT, gate, deps);

    expect(onGatePassed).toHaveBeenCalledWith(PROJECT, gate, PLUGIN);
    const entries = audit.query();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: "closeGate",
      outcome: "applied",
      refs: { gateId: "WU-040", trackerRef: "o/r#451" },
    });
  });

  it("closeGate skips and records 'skipped' for an unfiled gate", async () => {
    const { deps, audit, onGatePassed } = makeDeps();

    await closeGate(PROJECT, makeGate(null), deps);

    expect(onGatePassed).not.toHaveBeenCalled();
    expect(audit.query()[0]).toMatchObject({ action: "closeGate", outcome: "skipped" });
  });
});

describe("TrackerActionGateway: unconsented call is blocked (TC-048)", () => {
  it("refuses createIssue when the plugin is not consented, without invoking", async () => {
    const { deps, audit, invoke } = makeDeps({ hasConsent: () => false });

    await expect(
      createIssue(PROJECT, { repoFullName: "o/r", title: "x" }, deps),
    ).rejects.toBeInstanceOf(TrackerActionError);
    await expect(
      createIssue(PROJECT, { repoFullName: "o/r", title: "x" }, deps),
    ).rejects.toMatchObject({ code: "not-consented" });

    expect(invoke).not.toHaveBeenCalled();
    const refused = audit.query().filter((e) => e.outcome === "refused");
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused[0]).toMatchObject({
      action: "createIssue",
      outcome: "refused",
      reason: "plugin not consented",
    });
  });

  it("refuses closeGate when the plugin is not consented, without closing", async () => {
    const { deps, onGatePassed } = makeDeps({ hasConsent: () => false });

    await expect(closeGate(PROJECT, makeGate(), deps)).rejects.toMatchObject({
      code: "not-consented",
    });
    expect(onGatePassed).not.toHaveBeenCalled();
  });
});

describe("TrackerActionGateway: missing capability degrades, never a silent no-op (TC-050)", () => {
  it("refuses createIssue with a legible error when supportsCreateIssue is absent", async () => {
    const { deps, audit, invoke } = makeDeps({
      getCapabilities: () => ({ supportsCreateIssue: false }),
    });

    const error = await createIssue(PROJECT, { repoFullName: "o/r", title: "x" }, deps).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(TrackerActionError);
    expect(error.code).toBe("capability-absent");
    expect(error.message).toMatch(/supportsCreateIssue/);
    expect(invoke).not.toHaveBeenCalled();
    const refused = audit.query().filter((e) => e.outcome === "refused");
    expect(refused[0]).toMatchObject({
      action: "createIssue",
      reason: "capability supportsCreateIssue not declared",
    });
  });

  it("refuses addBlockedBy when the manifest has no capabilities at all", async () => {
    const { deps, invoke } = makeDeps({ getCapabilities: () => null });

    await expect(
      addBlockedBy(PROJECT, { blockedRef: "o/r#10", blockerRef: "o/r#11" }, deps),
    ).rejects.toMatchObject({ code: "capability-absent" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("closeGate does not require a capability flag (reuses applyTransition)", async () => {
    const { deps, onGatePassed } = makeDeps({ getCapabilities: () => ({}) });

    await closeGate(PROJECT, makeGate(), deps);

    expect(onGatePassed).toHaveBeenCalled();
  });

  it("throws no-active-integration when no plugin is configured", async () => {
    const { deps, invoke } = makeDeps({ resolveActivePlugin: () => null });

    await expect(
      createIssue(PROJECT, { repoFullName: "o/r", title: "x" }, deps),
    ).rejects.toMatchObject({ code: "no-active-integration" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("TrackerActionGateway: audit records carry no tracker tokens or secrets (NFR-001, TC-051)", () => {
  it("never places a credential on any audit entry across applied and refused paths", async () => {
    const secret = "ghp_supersecret_token_value";
    const { deps, audit, invoke } = makeDeps();
    invoke.mockResolvedValueOnce({ ref: "o/r#1", url: "u", nodeId: "N" });

    await createIssue(PROJECT, { repoFullName: "o/r", title: "t" }, deps);
    // A refused path too.
    const refusingDeps = makeDeps({ hasConsent: () => false, recordAudit: deps.recordAudit });
    await addBlockedBy(
      PROJECT,
      { blockedRef: "o/r#1", blockerRef: "o/r#2" },
      refusingDeps.deps,
    ).catch(() => undefined);

    const serialized = JSON.stringify(audit.query());
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/ghp_/);
    expect(serialized).not.toMatch(/token/i);
    // Every entry exposes only the documented non-secret fields.
    for (const entry of audit.query()) {
      const keys = Object.keys(entry).sort();
      expect(
        keys.every((k) =>
          ["ts", "projectId", "pluginId", "action", "outcome", "reason", "refs"].includes(k),
        ),
      ).toBe(true);
    }
  });
});
