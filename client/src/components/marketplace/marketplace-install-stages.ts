import type { InstallErrorCode, InstallSource } from "@roubo/shared";

// Client-derived 4-step install progress for the marketplace install/update UX
// (issue #374). The four stages already run server-side across the two existing
// calls: the preview mutation (POST /marketplace/plugins/:id/install) downloads
// the built artifact into staging, verifies the catalog ed25519 signature, and
// verifies the staged artifact's sha256 digest; the confirm mutation
// (POST /plugins/install/:token/confirm) atomically renames staging into
// ~/.roubo/plugins/<id> (the "Unpack & install" step). There is no per-stage
// server streaming (the first three stages complete inside the single atomic
// preview request), so progress is DERIVED from the React Query mutation
// lifecycle plus an InstallErrorCode -> failing-stage map. It is fail-closed: a
// failed signature or digest surfaces on its own stage, nothing written, nothing
// executed.

export type StageStatus = "pending" | "active" | "done" | "failed";

export const INSTALL_STAGE_COUNT = 4;

// Stable 0-based indices for the four labelled stages.
export const INSTALL_STAGE_INDEX = {
  download: 0,
  catalogSignature: 1,
  artifactDigest: 2,
  unpackInstall: 3,
} as const;

// Maps an InstallErrorCode to the 0-based index of the stage that fails:
//   download-failed                          -> stage 1 (Download built artifact)
//   catalog-unverified, marketplace-unreachable -> stage 2 (Verify catalog signature)
//   integrity-failed, unpack-failed          -> stage 3 (Verify artifact digest)
//   anything else (confirm/commit phase)     -> stage 4 (Unpack & install)
// Codes that can only surface during (or are not specific to a stage before) the
// confirm/commit phase fall through to the final "Unpack & install" stage.
export function stageIndexForErrorCode(code: InstallErrorCode | undefined): number {
  switch (code) {
    case "download-failed":
      return INSTALL_STAGE_INDEX.download;
    case "catalog-unverified":
    case "marketplace-unreachable":
      return INSTALL_STAGE_INDEX.catalogSignature;
    case "integrity-failed":
    case "unpack-failed":
      return INSTALL_STAGE_INDEX.artifactDigest;
    default:
      return INSTALL_STAGE_INDEX.unpackInstall;
  }
}

export interface StageStatusInput {
  // The preview (staging) mutation is in flight: stages 1-3 run as an active
  // group inside this single atomic request.
  stagingPending: boolean;
  // The preview succeeded: the package is staged and stages 1-3 are done. This
  // is the state while the consent modal is open, before the user confirms.
  stagingSettled: boolean;
  // The confirm (commit) mutation is in flight: stage 4 is active.
  confirmPending: boolean;
  // The confirm mutation succeeded: every stage is done.
  confirmSettled: boolean;
  // The phase a failure occurred in (if any). A staging failure is mapped to a
  // stage via its error code; a confirm failure always lands on stage 4.
  failedPhase?: "staging" | "confirm";
  errorCode?: InstallErrorCode;
}

// Derives the per-stage status array (always INSTALL_STAGE_COUNT entries) from
// the preview + confirm mutation lifecycle. Precedence is failure first (so a
// fail-closed stage is never masked by a stale pending flag), then completion,
// then in-flight, then the staged/idle states.
export function deriveStageStatuses(input: StageStatusInput): StageStatus[] {
  if (input.failedPhase) {
    const failed =
      input.failedPhase === "confirm"
        ? INSTALL_STAGE_INDEX.unpackInstall
        : stageIndexForErrorCode(input.errorCode);
    const statuses: StageStatus[] = [];
    for (let i = 0; i < INSTALL_STAGE_COUNT; i += 1) {
      if (i < failed) statuses.push("done");
      else if (i === failed) statuses.push("failed");
      else statuses.push("pending");
    }
    return statuses;
  }

  if (input.confirmSettled) {
    return ["done", "done", "done", "done"];
  }

  if (input.confirmPending) {
    return ["done", "done", "done", "active"];
  }

  if (input.stagingSettled) {
    return ["done", "done", "done", "pending"];
  }

  if (input.stagingPending) {
    return ["active", "active", "active", "pending"];
  }

  return ["pending", "pending", "pending", "pending"];
}

// A short, monospace label for the "Download built artifact" stage meta line: the
// Release asset filename for the built-artifact path, falling back to <id>-<version>
// for the git/local paths that have no single downloaded tarball.
export function describeArtifact(
  source: InstallSource,
  artifact: { id: string; version: string },
): string {
  if (source.type === "release") {
    const name = source.assetUrl.split("/").pop();
    if (name && name.length > 0) return name;
  }
  return `${artifact.id}-${artifact.version}`;
}
