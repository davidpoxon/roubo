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
//   integrity-failed, missing-integrity      -> stage 3 (Verify artifact digest)
//   unpack-failed, anything else (confirm/commit phase) -> stage 4 (Unpack & install)
// Codes that can only surface during (or are not specific to a stage before) the
// confirm/commit phase fall through to the final "Unpack & install" stage.
// missing-integrity (an unsigned entry with no usable digest, #559) is rejected
// BEFORE the download, so it precedes every stage. It is mapped to the digest
// stage regardless, because that is the stage whose promise it fails: mapping it
// to "Unpack & install" would misreport a pre-fetch refusal as an unpack failure.
// unpack-failed IS an unpack failure (a zip-slip / bad-entry-type / oversize
// containment rejection, or a non-archive download body), so it belongs on the
// stage literally named for that operation rather than sharing the digest stage.
export function stageIndexForErrorCode(code: InstallErrorCode | undefined): number {
  switch (code) {
    case "download-failed":
      return INSTALL_STAGE_INDEX.download;
    case "catalog-unverified":
    case "marketplace-unreachable":
      return INSTALL_STAGE_INDEX.catalogSignature;
    case "integrity-failed":
    case "missing-integrity":
      return INSTALL_STAGE_INDEX.artifactDigest;
    default:
      return INSTALL_STAGE_INDEX.unpackInstall;
  }
}

// The fail-closed message ("nothing written, nothing executed" framing) shown on
// a failed stage. More than one error code can route to the same stage with
// different meanings, so the message keys on the specific code where the stage
// has multiple causes, and falls back to the stage's default otherwise: an
// unreachable marketplace is not a failed signature even though both share the
// catalog-signature stage, and a missing digest is not a mismatch even though
// both share the artifact-digest stage.
export function stageFailMessage(stageIndex: number, code?: InstallErrorCode): string {
  switch (stageIndex) {
    case INSTALL_STAGE_INDEX.download:
      return "Download failed: nothing written, nothing executed.";
    case INSTALL_STAGE_INDEX.catalogSignature:
      return code === "marketplace-unreachable"
        ? "Marketplace unreachable: install paused, nothing written."
        : "Catalog signature unverified: install refused, nothing written.";
    case INSTALL_STAGE_INDEX.artifactDigest:
      // Not a mismatch: there was no digest to check against, so the artifact was
      // never fetched. Say that plainly rather than implying tampering (#559).
      if (code === "missing-integrity") {
        return "Uninstallable without a per-artifact digest: nothing fetched, nothing written.";
      }
      return "Digest mismatch: nothing written, nothing executed.";
    case INSTALL_STAGE_INDEX.unpackInstall:
      if (code === "unpack-failed") {
        return "Artifact could not be safely unpacked: nothing written, nothing executed.";
      }
      return "Install failed: nothing written, nothing executed.";
    default:
      return "Install failed: nothing written, nothing executed.";
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
    // unpack-failed's UI stage (Unpack & install, index 3) sits after the
    // artifact-digest stage (index 2) in the labelled list, but the real
    // pipeline unpacks BEFORE verifying the digest (issue #370): an unpack
    // failure means the digest check never ran. Don't mark that earlier-indexed
    // stage "done" just because its UI position precedes the one that failed.
    const digestNeverReached =
      input.failedPhase === "staging" && input.errorCode === "unpack-failed";
    const statuses: StageStatus[] = [];
    for (let i = 0; i < INSTALL_STAGE_COUNT; i += 1) {
      if (digestNeverReached && i === INSTALL_STAGE_INDEX.artifactDigest) {
        statuses.push("pending");
      } else if (i < failed) {
        statuses.push("done");
      } else if (i === failed) {
        statuses.push("failed");
      } else {
        statuses.push("pending");
      }
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
