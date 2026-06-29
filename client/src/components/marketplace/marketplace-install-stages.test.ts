// Unit tests for the client-derived 4-step install progress helpers (issue
// #374). These are pure functions, so they are tested in isolation from the
// widget: the InstallErrorCode -> failing-stage map, the mutation-lifecycle ->
// per-stage status derivation (fail-closed precedence), and the artifact meta
// label.

import { describe, it, expect } from "vitest";
import type { InstallErrorCode, InstallSource, PluginManifest } from "@roubo/shared";
import {
  INSTALL_STAGE_INDEX,
  deriveStageStatuses,
  describeArtifact,
  stageFailMessage,
  stageIndexForErrorCode,
  type StageStatusInput,
} from "./marketplace-install-stages";

function input(over: Partial<StageStatusInput> = {}): StageStatusInput {
  return {
    stagingPending: false,
    stagingSettled: false,
    confirmPending: false,
    confirmSettled: false,
    ...over,
  };
}

describe("stageIndexForErrorCode", () => {
  it("maps download-failed to the Download stage", () => {
    expect(stageIndexForErrorCode("download-failed")).toBe(INSTALL_STAGE_INDEX.download);
  });

  it("maps catalog-unverified and marketplace-unreachable to the Verify catalog signature stage", () => {
    expect(stageIndexForErrorCode("catalog-unverified")).toBe(INSTALL_STAGE_INDEX.catalogSignature);
    expect(stageIndexForErrorCode("marketplace-unreachable")).toBe(
      INSTALL_STAGE_INDEX.catalogSignature,
    );
  });

  it("maps integrity-failed and unpack-failed to the Verify artifact digest stage", () => {
    expect(stageIndexForErrorCode("integrity-failed")).toBe(INSTALL_STAGE_INDEX.artifactDigest);
    expect(stageIndexForErrorCode("unpack-failed")).toBe(INSTALL_STAGE_INDEX.artifactDigest);
  });

  it("maps any other / confirm-phase code (and undefined) to the Unpack & install stage", () => {
    const others: (InstallErrorCode | undefined)[] = [
      "duplicate-id",
      "unknown-token",
      "internal",
      undefined,
    ];
    for (const code of others) {
      expect(stageIndexForErrorCode(code)).toBe(INSTALL_STAGE_INDEX.unpackInstall);
    }
  });
});

describe("stageFailMessage", () => {
  it("returns the download stage message", () => {
    expect(stageFailMessage(INSTALL_STAGE_INDEX.download)).toMatch(/^Download failed:/);
  });

  it("returns the signature failure message for a signature failure on the catalog-signature stage", () => {
    expect(stageFailMessage(INSTALL_STAGE_INDEX.catalogSignature, "catalog-unverified")).toMatch(
      /^Catalog signature unverified:/,
    );
    // Default (no code) keeps the signature wording.
    expect(stageFailMessage(INSTALL_STAGE_INDEX.catalogSignature)).toMatch(
      /^Catalog signature unverified:/,
    );
  });

  it("does NOT call an unreachable marketplace a signature failure", () => {
    const message = stageFailMessage(
      INSTALL_STAGE_INDEX.catalogSignature,
      "marketplace-unreachable",
    );
    expect(message).toMatch(/^Marketplace unreachable:/);
    expect(message).not.toMatch(/signature/i);
  });

  it("returns the digest mismatch message for an integrity failure (and by default)", () => {
    expect(stageFailMessage(INSTALL_STAGE_INDEX.artifactDigest, "integrity-failed")).toMatch(
      /^Digest mismatch:/,
    );
    expect(stageFailMessage(INSTALL_STAGE_INDEX.artifactDigest)).toMatch(/^Digest mismatch:/);
  });

  it("does NOT call an unpack containment rejection a digest mismatch (issue #374 corr-1)", () => {
    const message = stageFailMessage(INSTALL_STAGE_INDEX.artifactDigest, "unpack-failed");
    expect(message).toMatch(/could not be safely unpacked/i);
    expect(message).not.toMatch(/digest mismatch/i);
  });

  it("returns the generic install-failed message for the Unpack & install stage", () => {
    expect(stageFailMessage(INSTALL_STAGE_INDEX.unpackInstall)).toMatch(/^Install failed:/);
  });

  it("keeps the fail-closed framing on every message", () => {
    for (let i = 0; i < 4; i += 1) {
      expect(stageFailMessage(i)).toMatch(/nothing written/i);
    }
  });
});

describe("deriveStageStatuses", () => {
  it("is all-pending when idle", () => {
    expect(deriveStageStatuses(input())).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("runs stages 1-3 as an active group with stage 4 pending while the preview is in flight", () => {
    expect(deriveStageStatuses(input({ stagingPending: true }))).toEqual([
      "active",
      "active",
      "active",
      "pending",
    ]);
  });

  it("marks stages 1-3 done and stage 4 pending once the preview is staged (consent open)", () => {
    expect(deriveStageStatuses(input({ stagingSettled: true }))).toEqual([
      "done",
      "done",
      "done",
      "pending",
    ]);
  });

  it("activates stage 4 while the confirm mutation is in flight", () => {
    expect(deriveStageStatuses(input({ stagingSettled: true, confirmPending: true }))).toEqual([
      "done",
      "done",
      "done",
      "active",
    ]);
  });

  it("marks every stage done when the confirm mutation succeeds", () => {
    expect(deriveStageStatuses(input({ confirmSettled: true }))).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
  });

  it("fails the digest stage (3) fail-closed on a staging integrity failure, leaving stage 4 pending", () => {
    expect(
      deriveStageStatuses(input({ failedPhase: "staging", errorCode: "integrity-failed" })),
    ).toEqual(["done", "done", "failed", "pending"]);
  });

  it("fails the catalog-signature stage (2) on a staging catalog-unverified failure", () => {
    expect(
      deriveStageStatuses(input({ failedPhase: "staging", errorCode: "catalog-unverified" })),
    ).toEqual(["done", "failed", "pending", "pending"]);
  });

  it("fails the download stage (1) on a staging download failure", () => {
    expect(
      deriveStageStatuses(input({ failedPhase: "staging", errorCode: "download-failed" })),
    ).toEqual(["failed", "pending", "pending", "pending"]);
  });

  it("fails the Unpack & install stage (4) on a confirm-phase failure regardless of code", () => {
    expect(deriveStageStatuses(input({ failedPhase: "confirm" }))).toEqual([
      "done",
      "done",
      "done",
      "failed",
    ]);
  });

  it("prioritises a failure over a stale pending flag (fail-closed precedence)", () => {
    expect(
      deriveStageStatuses(
        input({ stagingPending: true, failedPhase: "staging", errorCode: "integrity-failed" }),
      ),
    ).toEqual(["done", "done", "failed", "pending"]);
  });
});

describe("describeArtifact", () => {
  function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
    return { id: "ghe", version: "0.2.0", ...over } as PluginManifest;
  }

  it("uses the Release asset filename for the built-artifact (release) path", () => {
    const source: InstallSource = {
      type: "release",
      assetUrl: "https://example.com/d/ghe-0.2.0.tgz",
    };
    expect(describeArtifact(source, manifest())).toBe("ghe-0.2.0.tgz");
  });

  it("falls back to <id>-<version> when the release asset url has no filename", () => {
    const source: InstallSource = { type: "release", assetUrl: "https://example.com/" };
    expect(describeArtifact(source, manifest())).toBe("ghe-0.2.0");
  });

  it("falls back to <id>-<version> for the git path", () => {
    const source: InstallSource = { type: "git", url: "https://example.com/ghe.git" };
    expect(describeArtifact(source, manifest())).toBe("ghe-0.2.0");
  });
});
