import { describe, it, expect, vi } from "vitest";
import {
  EmptyNotesError,
  fileFixIssueAndBlock,
  type FileFixIssueParams,
  type FixIssueFilerDeps,
} from "./fix-issue-filer.js";
import { TrackerActionError } from "./tracker-action-gateway.js";
import type { CreateIssueResult } from "@roubo/plugin-sdk";

const PROJECT = "proj-1";
const PLUGIN = "github-com";

const PARAMS: FileFixIssueParams = {
  repoFullName: "o/r",
  failedCaseId: "TC-024",
  gateRef: "o/r#451",
  notes: "The login button does nothing on click.",
};

// A deps factory with the active plugin present + both capabilities declared by
// default; each test overrides only the seam it exercises. Mirrors the gateway
// test's makeDeps() shape.
function makeDeps(overrides: Partial<FixIssueFilerDeps> = {}): {
  deps: FixIssueFilerDeps;
  createIssue: ReturnType<typeof vi.fn>;
  addBlockedBy: ReturnType<typeof vi.fn>;
} {
  const created: CreateIssueResult = {
    ref: "o/r#452",
    url: "https://github.com/o/r/issues/452",
    nodeId: "N452",
  };
  const createIssue = vi.fn(async () => created);
  const addBlockedBy = vi.fn(async () => undefined);
  const deps: FixIssueFilerDeps = {
    resolveActivePlugin: () => ({ pluginId: PLUGIN, integrationId: PLUGIN, pageSize: 50 }),
    getCapabilities: () => ({ supportsCreateIssue: true, supportsBlockingLinks: true }),
    createIssue: createIssue as unknown as FixIssueFilerDeps["createIssue"],
    addBlockedBy: addBlockedBy as unknown as FixIssueFilerDeps["addBlockedBy"],
    now: () => "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  return { deps, createIssue, addBlockedBy };
}

describe("FixIssueFiler: success creates the issue and links it (TC-045, TC-046)", () => {
  it("creates the fix issue then registers it as a gate blocker, returning complete", async () => {
    const { deps, createIssue, addBlockedBy } = makeDeps();

    const record = await fileFixIssueAndBlock(PROJECT, PARAMS, deps);

    expect(record).toEqual({
      fixIssueRef: "o/r#452",
      gateRef: "o/r#451",
      failedCaseId: "TC-024",
      linkStatus: "complete",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    // Create is called with the notes as the body, before the link step.
    expect(createIssue).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ repoFullName: "o/r", body: PARAMS.notes }),
    );
    // The fix issue (#452) blocks the gate (#451): blockedRef is the gate.
    expect(addBlockedBy).toHaveBeenCalledWith(PROJECT, {
      blockedRef: "o/r#451",
      blockerRef: "o/r#452",
    });
    expect(createIssue.mock.invocationCallOrder[0]).toBeLessThan(
      addBlockedBy.mock.invocationCallOrder[0],
    );
  });
});

describe("FixIssueFiler: post-create link failure surfaces link_pending (TC-052)", () => {
  it("returns link_pending with the created ref when addBlockedBy fails after create", async () => {
    const addBlockedBy = vi.fn(async () => {
      throw new Error("transient tracker error");
    });
    const { deps } = makeDeps({
      addBlockedBy: addBlockedBy as unknown as FixIssueFilerDeps["addBlockedBy"],
    });

    const record = await fileFixIssueAndBlock(PROJECT, PARAMS, deps);

    expect(record).toMatchObject({
      fixIssueRef: "o/r#452",
      gateRef: "o/r#451",
      failedCaseId: "TC-024",
      linkStatus: "link_pending",
    });
    // The issue WAS created; the partial state is surfaced, not thrown.
    expect(addBlockedBy).toHaveBeenCalledTimes(1);
  });

  it("does not re-create the issue: a link failure leaves exactly one create call", async () => {
    const createIssue = vi.fn(async () => ({ ref: "o/r#452", url: "u" }) as CreateIssueResult);
    const addBlockedBy = vi.fn(async () => {
      throw new Error("transient");
    });
    const { deps } = makeDeps({
      createIssue: createIssue as unknown as FixIssueFilerDeps["createIssue"],
      addBlockedBy: addBlockedBy as unknown as FixIssueFilerDeps["addBlockedBy"],
    });

    const record = await fileFixIssueAndBlock(PROJECT, PARAMS, deps);

    expect(record.linkStatus).toBe("link_pending");
    expect(createIssue).toHaveBeenCalledTimes(1);
  });
});

describe("FixIssueFiler: link-only retry via existingFixRef (TC-052)", () => {
  it("runs only the link step against the existing ref and returns complete", async () => {
    const { deps, createIssue, addBlockedBy } = makeDeps();

    const record = await fileFixIssueAndBlock(
      PROJECT,
      { ...PARAMS, existingFixRef: "o/r#452" },
      deps,
    );

    // No new issue is created on a link-only retry.
    expect(createIssue).not.toHaveBeenCalled();
    expect(addBlockedBy).toHaveBeenCalledWith(PROJECT, {
      blockedRef: "o/r#451",
      blockerRef: "o/r#452",
    });
    expect(record).toMatchObject({
      fixIssueRef: "o/r#452",
      linkStatus: "complete",
    });
  });

  it("propagates a link failure on retry without creating an issue", async () => {
    const addBlockedBy = vi.fn(async () => {
      throw new Error("still failing");
    });
    const { deps, createIssue } = makeDeps({
      addBlockedBy: addBlockedBy as unknown as FixIssueFilerDeps["addBlockedBy"],
    });

    await expect(
      fileFixIssueAndBlock(PROJECT, { ...PARAMS, existingFixRef: "o/r#452" }, deps),
    ).rejects.toThrow("still failing");
    expect(createIssue).not.toHaveBeenCalled();
  });
});

describe("FixIssueFiler: empty notes are rejected before any tracker call (TC-053)", () => {
  it.each([
    ["empty string", ""],
    ["whitespace only", "   \n\t  "],
  ])("rejects %s with EmptyNotesError and makes no tracker call", async (_label, notes) => {
    const { deps, createIssue, addBlockedBy } = makeDeps();

    await expect(fileFixIssueAndBlock(PROJECT, { ...PARAMS, notes }, deps)).rejects.toBeInstanceOf(
      EmptyNotesError,
    );
    expect(createIssue).not.toHaveBeenCalled();
    expect(addBlockedBy).not.toHaveBeenCalled();
  });
});

describe("FixIssueFiler: capability-absent degrades up front, never an orphan issue (TC-049 degrade)", () => {
  it("throws capability-absent and creates nothing when supportsBlockingLinks is absent", async () => {
    const { deps, createIssue, addBlockedBy } = makeDeps({
      getCapabilities: () => ({ supportsCreateIssue: true, supportsBlockingLinks: false }),
    });

    const error = await fileFixIssueAndBlock(PROJECT, PARAMS, deps).catch((e) => e);

    expect(error).toBeInstanceOf(TrackerActionError);
    expect(error.code).toBe("capability-absent");
    expect(error.message).toMatch(/supportsBlockingLinks/);
    // Pre-flight is up front: a tracker that cannot link never gets a create call.
    expect(createIssue).not.toHaveBeenCalled();
    expect(addBlockedBy).not.toHaveBeenCalled();
  });

  it("throws capability-absent when supportsCreateIssue is absent", async () => {
    const { deps, createIssue } = makeDeps({
      getCapabilities: () => ({ supportsBlockingLinks: true }),
    });

    await expect(fileFixIssueAndBlock(PROJECT, PARAMS, deps)).rejects.toMatchObject({
      code: "capability-absent",
    });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("throws no-active-integration when no plugin is configured", async () => {
    const { deps, createIssue } = makeDeps({ resolveActivePlugin: () => null });

    await expect(fileFixIssueAndBlock(PROJECT, PARAMS, deps)).rejects.toMatchObject({
      code: "no-active-integration",
    });
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("link-only retry pre-flights only the link capability", async () => {
    // supportsCreateIssue is absent, but a link-only retry does not need it.
    const { deps, addBlockedBy } = makeDeps({
      getCapabilities: () => ({ supportsBlockingLinks: true }),
    });

    const record = await fileFixIssueAndBlock(
      PROJECT,
      { ...PARAMS, existingFixRef: "o/r#452" },
      deps,
    );

    expect(record.linkStatus).toBe("complete");
    expect(addBlockedBy).toHaveBeenCalledTimes(1);
  });
});
