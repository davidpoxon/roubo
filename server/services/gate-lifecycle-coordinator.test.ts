import { describe, it, expect, vi } from "vitest";
import {
  onGatePassed,
  onGateReopened,
  pickDoneTransition,
  pickReopenTransition,
  isDone,
  GateAuditLog,
  type GateLifecycleDeps,
} from "./gate-lifecycle-coordinator.js";
import type { VerifyUnit } from "../lib/gate-evaluator.js";
import type { GateAuditEntry, NormalizedIssue } from "@roubo/shared";
import type { Tracker } from "@roubo/shared/work-units-contract";

// ── Builders ──

// Pass `null` for trackerRef to model an unfiled gate (no tracker block); a
// string sets the ref. A bare call defaults to "451".
function makeGate(trackerRef: string | null = "451"): VerifyUnit {
  const tracker: Tracker | undefined =
    trackerRef === null
      ? undefined
      : {
          system: "github",
          ref: trackerRef,
          url: `https://github.com/o/r/issues/${trackerRef}`,
          blocked_by_refs: [],
        };
  return {
    id: "WU-040",
    title: "Verify batch Phase 2",
    type: "task",
    kind: "verify",
    description: "Gate over Phase 2",
    acceptance_criteria: [],
    depends_on: [],
    covers: [],
    implements: { requirement_ids: [], user_story_ids: [], test_case_ids: ["TC-001"] },
    ...(tracker ? { tracker } : {}),
  };
}

function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    integrationId: "github-com",
    externalId: "451",
    externalUrl: "https://github.com/o/r/issues/451",
    title: "Phase 2 verify gate",
    body: null,
    currentState: "open",
    allowedTransitions: ["close"],
    assignees: [],
    labels: [],
    issueType: null,
    blocks: [],
    blockedBy: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
    raw: {},
    ...overrides,
  };
}

// A deps factory: an `invoke` that returns the supplied issue for getIssue and
// records applyTransition calls, plus an in-memory audit log. A fixed clock keeps
// timestamps deterministic.
function makeDeps(opts: {
  issue?: NormalizedIssue;
  getIssueError?: Error;
  applyTransitionError?: Error;
}) {
  const audit = new GateAuditLog();
  const applyTransitionCalls: Array<{ externalId: string; transitionName: string }> = [];

  const invoke = vi.fn(async (_pluginId: string, method: string, params: unknown) => {
    if (method === "getIssue") {
      if (opts.getIssueError) throw opts.getIssueError;
      return (opts.issue ?? makeIssue()) as never;
    }
    if (method === "applyTransition") {
      if (opts.applyTransitionError) throw opts.applyTransitionError;
      applyTransitionCalls.push(params as { externalId: string; transitionName: string });
      return makeIssue({ currentState: "closed", allowedTransitions: ["reopen"] }) as never;
    }
    throw new Error(`unexpected method ${method}`);
  });

  const deps: GateLifecycleDeps = {
    invoke: invoke as unknown as GateLifecycleDeps["invoke"],
    recordAudit: (entry) => audit.record(entry),
    now: () => "2026-06-22T00:00:00.000Z",
  };

  return { deps, audit, invoke, applyTransitionCalls };
}

// ── AC1 + AC2 + NFR-001: close-on-pass routes through applyTransition and is
// audit-logged (TC-038, TC-041) ──

describe("onGatePassed: closes a passed gate via the plugin transition (FR-007, TC-038, TC-041)", () => {
  it("applies a done-bound transition through the plugin and audit-logs the close", async () => {
    const { deps, audit, applyTransitionCalls, invoke } = makeDeps({ issue: makeIssue() });

    await onGatePassed("proj-1", makeGate("451"), "github-com", deps);

    // Routed through applyTransition with the done transition from allowedTransitions
    // (AC2). The bare contract ref "451" is qualified to "o/r#451" for the plugin
    // (issue #1006), while the audit entry keeps the bare ref.
    expect(applyTransitionCalls).toEqual([{ externalId: "o/r#451", transitionName: "close" }]);
    expect(invoke).toHaveBeenCalledWith("github-com", "getIssue", { externalId: "o/r#451" });

    // Audit-logged with the gate, plugin, tracker ref and transition (NFR-001).
    const entries = audit.query();
    expect(entries).toEqual<GateAuditEntry[]>([
      {
        ts: "2026-06-22T00:00:00.000Z",
        projectId: "proj-1",
        pluginId: "github-com",
        gateId: "WU-040",
        trackerRef: "451",
        transitionName: "close",
        outcome: "closed",
      },
    ]);
  });
});

// ── Regression (issue #1006): a contract-conformant BARE tracker.ref (an issue
// number, per shared/work-units-contract.ts TrackerSchema) must be qualified to
// the bundled GitHub plugin's `owner/repo#<n>` externalId before it reaches
// getIssue / applyTransition, not passed verbatim (which the plugin rejects with
// `missing "#"`). ──

describe("onGatePassed / onGateReopened: qualify a bare tracker.ref (issue #1006)", () => {
  // A deps.invoke that faithfully rejects a bare (unqualified) externalId the way
  // the bundled GitHub plugin's parseGithubExternalId does, so a verbatim bare ref
  // would reproduce the issue's `missing "#"` crash here.
  function makePluginFaithfulDeps() {
    const audit = new GateAuditLog();
    const applyTransitionCalls: Array<{ externalId: string; transitionName: string }> = [];
    const invoke = vi.fn(async (_pluginId: string, method: string, params: unknown) => {
      const { externalId } = params as { externalId: string };
      if (!externalId.includes("#")) {
        throw new Error(`[shared-github] externalId "${externalId}" missing "#".`);
      }
      if (method === "getIssue") return makeIssue({ externalId }) as never;
      if (method === "applyTransition") {
        applyTransitionCalls.push(params as { externalId: string; transitionName: string });
        return makeIssue({ currentState: "closed", allowedTransitions: ["reopen"] }) as never;
      }
      throw new Error(`unexpected method ${method}`);
    });
    const deps: GateLifecycleDeps = {
      invoke: invoke as unknown as GateLifecycleDeps["invoke"],
      recordAudit: (entry) => audit.record(entry),
      now: () => "2026-06-22T00:00:00.000Z",
    };
    return { deps, audit, invoke, applyTransitionCalls };
  }

  it("onGatePassed qualifies the bare ref, keeping the audit ref bare", async () => {
    const { deps, audit, invoke, applyTransitionCalls } = makePluginFaithfulDeps();

    // makeGate("1033") carries url https://github.com/o/r/issues/1033.
    await expect(
      onGatePassed("proj-1", makeGate("1033"), "github-com", deps),
    ).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith("github-com", "getIssue", { externalId: "o/r#1033" });
    expect(applyTransitionCalls).toEqual([{ externalId: "o/r#1033", transitionName: "close" }]);
    // The audit entry keeps the BARE contract ref, not the qualified externalId.
    expect(audit.query()[0]).toMatchObject({ trackerRef: "1033", outcome: "closed" });
  });

  it("onGateReopened qualifies the bare ref, keeping the audit ref bare", async () => {
    const { deps, audit, invoke, applyTransitionCalls } = makePluginFaithfulDeps();
    // A closed issue so reopen has a reopen-bound transition to apply.
    invoke.mockImplementation(async (_pluginId, method, params) => {
      const { externalId } = params as { externalId: string };
      if (!externalId.includes("#")) {
        throw new Error(`[shared-github] externalId "${externalId}" missing "#".`);
      }
      if (method === "getIssue") {
        return makeIssue({
          externalId,
          currentState: "closed",
          allowedTransitions: ["reopen"],
        }) as never;
      }
      applyTransitionCalls.push(params as { externalId: string; transitionName: string });
      return makeIssue({ currentState: "open", allowedTransitions: ["close"] }) as never;
    });

    await expect(
      onGateReopened("proj-1", makeGate("1033"), "github-com", deps),
    ).resolves.toBeUndefined();

    expect(invoke).toHaveBeenCalledWith("github-com", "getIssue", { externalId: "o/r#1033" });
    expect(applyTransitionCalls).toEqual([{ externalId: "o/r#1033", transitionName: "reopen" }]);
    expect(audit.query()[0]).toMatchObject({ trackerRef: "1033", outcome: "reopened" });
  });
});

// ── AC3: idempotent no-op when the gate issue is already done (TC-042) ──

describe("onGatePassed: idempotent on an already-closed gate (FR-007, TC-042)", () => {
  it("does not apply a transition when the tracker issue is already done", async () => {
    const closedIssue = makeIssue({ currentState: "closed", allowedTransitions: ["reopen"] });
    const { deps, audit, applyTransitionCalls } = makeDeps({ issue: closedIssue });

    await onGatePassed("proj-1", makeGate("451"), "github-com", deps);

    // No duplicate transition applied (TC-042 S001-O02).
    expect(applyTransitionCalls).toEqual([]);
    // No second `closed` entry: the only record is the idempotent skip marker (TC-042 S001-O03).
    const closedEntries = audit.query().filter((e) => e.outcome === "closed");
    expect(closedEntries).toEqual([]);
    expect(audit.query()[0]?.outcome).toBe("already-done");
  });

  it("treats every DONE_STATUSES value (case-insensitively) as done", async () => {
    for (const state of ["done", "Closed", "ARCHIVED", "cancelled"]) {
      const { deps, applyTransitionCalls } = makeDeps({
        issue: makeIssue({ currentState: state, allowedTransitions: ["reopen"] }),
      });
      await onGatePassed("proj-1", makeGate("451"), "github-com", deps);
      expect(applyTransitionCalls).toEqual([]);
    }
  });
});

// ── AC4: a plugin-rejected close throws and leaves the gate not half-closed
// (TC-043) ──

describe("onGatePassed: a rejected close surfaces an error and leaves the issue open (FR-007, TC-043)", () => {
  it("propagates an applyTransition rejection and records no audit entry", async () => {
    const rejection = new Error("permission denied");
    const { deps, audit, invoke } = makeDeps({
      issue: makeIssue(),
      applyTransitionError: rejection,
    });

    await expect(onGatePassed("proj-1", makeGate("451"), "github-com", deps)).rejects.toThrow(
      "permission denied",
    );

    // The transition was attempted (so it is a genuine close attempt)...
    expect(invoke).toHaveBeenCalledWith("github-com", "applyTransition", {
      externalId: "o/r#451",
      transitionName: "close",
    });
    // ...but no audit entry was recorded for the failed call: the gate is not
    // recorded as closed, so it is never half-closed (AC4).
    expect(audit.query()).toEqual([]);
  });

  it("propagates a getIssue rejection without recording anything", async () => {
    const { deps, audit } = makeDeps({ getIssueError: new Error("network down") });

    await expect(onGatePassed("proj-1", makeGate("451"), "github-com", deps)).rejects.toThrow(
      "network down",
    );
    expect(audit.query()).toEqual([]);
  });

  it("throws a clear error when the issue exposes no done-bound transition", async () => {
    const { deps, audit } = makeDeps({
      issue: makeIssue({ currentState: "open", allowedTransitions: ["reopen"] }),
    });

    await expect(onGatePassed("proj-1", makeGate("451"), "github-com", deps)).rejects.toThrow(
      /no done-bound transition/,
    );
    expect(audit.query()).toEqual([]);
  });
});

// ── AC5: a non-passed gate is never closed. The coordinator only acts on what it
// is handed; the caller gates on `evaluateGate === passed`. Here we assert the
// no-tracker guard, the only path by which the coordinator itself can refuse. ──

describe("onGatePassed: a gate with no filed tracker is a no-op (FR-007)", () => {
  it("does nothing when the gate has no tracker.ref", async () => {
    const { deps, audit, invoke } = makeDeps({ issue: makeIssue() });

    await onGatePassed("proj-1", makeGate(null), "github-com", deps);

    expect(invoke).not.toHaveBeenCalled();
    expect(audit.query()).toEqual([]);
  });
});

// ── onGateReopened: reopen a signed-off gate's tracker issue (issue #830) ──

describe("onGateReopened: reopens a signed-off gate via the plugin transition (#830)", () => {
  it("applies a reopen-bound transition through the plugin and audit-logs the reopen", async () => {
    const closedIssue = makeIssue({ currentState: "closed", allowedTransitions: ["reopen"] });
    const { deps, audit, applyTransitionCalls, invoke } = makeDeps({ issue: closedIssue });

    await onGateReopened("proj-1", makeGate("451"), "github-com", deps);

    // Routed through applyTransition with the reopen transition from
    // allowedTransitions. The bare contract ref "451" is qualified to "o/r#451" for
    // the plugin (issue #1006), while the audit entry keeps the bare ref.
    expect(applyTransitionCalls).toEqual([{ externalId: "o/r#451", transitionName: "reopen" }]);
    expect(invoke).toHaveBeenCalledWith("github-com", "getIssue", { externalId: "o/r#451" });

    const entries = audit.query();
    expect(entries).toEqual<GateAuditEntry[]>([
      {
        ts: "2026-06-22T00:00:00.000Z",
        projectId: "proj-1",
        pluginId: "github-com",
        gateId: "WU-040",
        trackerRef: "451",
        transitionName: "reopen",
        outcome: "reopened",
      },
    ]);
  });

  it("is an idempotent no-op when the tracker issue is already open", async () => {
    const { deps, audit, applyTransitionCalls } = makeDeps({ issue: makeIssue() });

    await onGateReopened("proj-1", makeGate("451"), "github-com", deps);

    expect(applyTransitionCalls).toEqual([]);
    expect(audit.query()[0]?.outcome).toBe("already-open");
  });

  it("propagates an applyTransition rejection and records no audit entry", async () => {
    const { deps, audit } = makeDeps({
      issue: makeIssue({ currentState: "closed", allowedTransitions: ["reopen"] }),
      applyTransitionError: new Error("permission denied"),
    });

    await expect(onGateReopened("proj-1", makeGate("451"), "github-com", deps)).rejects.toThrow(
      "permission denied",
    );
    expect(audit.query()).toEqual([]);
  });

  it("throws a clear error when the closed issue exposes no reopen-bound transition", async () => {
    const { deps, audit } = makeDeps({
      issue: makeIssue({ currentState: "closed", allowedTransitions: ["close"] }),
    });

    await expect(onGateReopened("proj-1", makeGate("451"), "github-com", deps)).rejects.toThrow(
      /no reopen-bound transition/,
    );
    expect(audit.query()).toEqual([]);
  });

  it("does nothing when the gate has no tracker.ref", async () => {
    const { deps, audit, invoke } = makeDeps({ issue: makeIssue() });

    await onGateReopened("proj-1", makeGate(null), "github-com", deps);

    expect(invoke).not.toHaveBeenCalled();
    expect(audit.query()).toEqual([]);
  });
});

// ── pickReopenTransition (issue #830) ──

describe("pickReopenTransition", () => {
  it("picks the GitHub reopen transition", () => {
    expect(pickReopenTransition(makeIssue({ allowedTransitions: ["reopen"] }))).toBe("reopen");
  });

  it("matches a reopen-ish verb case-insensitively", () => {
    expect(pickReopenTransition(makeIssue({ allowedTransitions: ["Reopen Issue"] }))).toBe(
      "Reopen Issue",
    );
    expect(pickReopenTransition(makeIssue({ allowedTransitions: ["Open"] }))).toBe("Open");
  });

  it("returns undefined when no transition is reopen-bound", () => {
    expect(pickReopenTransition(makeIssue({ allowedTransitions: ["close"] }))).toBeUndefined();
    expect(pickReopenTransition(makeIssue({ allowedTransitions: [] }))).toBeUndefined();
  });
});

// ── isDone (issue #830) ──

describe("isDone", () => {
  it("treats every DONE_STATUSES value (case-insensitively) as done, others as not", () => {
    for (const state of ["done", "Closed", "ARCHIVED", "cancelled"]) {
      expect(isDone(makeIssue({ currentState: state }))).toBe(true);
    }
    expect(isDone(makeIssue({ currentState: "open" }))).toBe(false);
    expect(isDone(makeIssue({ currentState: "in_progress" }))).toBe(false);
  });
});

// ── pickDoneTransition ──

describe("pickDoneTransition", () => {
  it("picks the GitHub close transition", () => {
    expect(pickDoneTransition(makeIssue({ allowedTransitions: ["close"] }))).toBe("close");
  });

  it("matches a done-ish verb case-insensitively", () => {
    expect(pickDoneTransition(makeIssue({ allowedTransitions: ["Resolve Issue"] }))).toBe(
      "Resolve Issue",
    );
  });

  it("matches a transition whose name is a done state", () => {
    expect(pickDoneTransition(makeIssue({ allowedTransitions: ["Done"] }))).toBe("Done");
  });

  it("returns undefined when no transition is done-bound", () => {
    expect(pickDoneTransition(makeIssue({ allowedTransitions: ["reopen"] }))).toBeUndefined();
    expect(pickDoneTransition(makeIssue({ allowedTransitions: [] }))).toBeUndefined();
  });
});

// ── GateAuditLog ──

describe("GateAuditLog", () => {
  it("appends in chronological order and filters by project and plugin", () => {
    const log = new GateAuditLog();
    const base: GateAuditEntry = {
      ts: "2026-06-22T00:00:00.000Z",
      projectId: "proj-1",
      pluginId: "github-com",
      gateId: "WU-040",
      trackerRef: "451",
      transitionName: "close",
      outcome: "closed",
    };
    log.record(base);
    log.record({ ...base, projectId: "proj-2", trackerRef: "452" });
    log.record({ ...base, pluginId: "jira", trackerRef: "453" });

    expect(log.query()).toHaveLength(3);
    expect(log.query({ projectId: "proj-1" })).toHaveLength(2);
    expect(log.query({ pluginId: "jira" })).toHaveLength(1);

    log.clear();
    expect(log.query()).toEqual([]);
  });

  it("returns a copy so callers cannot mutate the store", () => {
    const log = new GateAuditLog();
    log.record({
      ts: "2026-06-22T00:00:00.000Z",
      projectId: "proj-1",
      pluginId: "github-com",
      gateId: "WU-040",
      trackerRef: "451",
      outcome: "already-done",
    });
    log.query().pop();
    expect(log.query()).toHaveLength(1);
  });
});
