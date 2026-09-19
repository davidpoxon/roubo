import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import type { InstallErrorCode } from "@roubo/shared";
import {
  INSTALL_STAGE_COUNT,
  stageFailMessage,
  type StageStatus,
} from "./marketplace-install-stages";

// The 4-step install/update progress surface (issue #374, CPHM-TC-017 S002-O01).
// It mirrors the prototype's labelled steps
// (.specifications/component-plugins-hosted-marketplace/prototype/index.html):
// a numbered badge that flips to a check on completion, an amber active state, a
// red cross + fail-closed message on failure. The four stages map onto the real
// pipeline (download -> verify catalog signature ed25519 -> verify artifact
// digest sha256 -> unpack & install into ~/.roubo/plugins/<id>). It is purely
// presentational: the parent derives the per-stage statuses (see
// marketplace-install-stages.ts) from the preview + confirm mutation lifecycle.

const STAGE_LABELS = [
  "Download built artifact",
  "Verify catalog signature",
  "Verify artifact digest",
  "Unpack & install",
] as const;

const BADGE_CLASS: Record<StageStatus, string> = {
  pending: "bg-bg-surface text-text-secondary border-status-idle",
  active: "bg-bg-surface text-text-primary border-status-preparing",
  done: "bg-success-surface text-success-text border-status-active",
  failed: "bg-danger-surface text-danger-text border-status-error",
};

const LABEL_CLASS: Record<StageStatus, string> = {
  pending: "text-text-secondary",
  active: "text-text-primary font-medium",
  done: "text-text-body",
  failed: "text-danger-text font-medium",
};

function badgeContent(status: StageStatus, index: number): ReactNode {
  if (status === "done") return <Check size={12} strokeWidth={3} aria-hidden />;
  if (status === "failed") return <X size={12} strokeWidth={3} aria-hidden />;
  return index + 1;
}

interface Props {
  // One StageStatus per stage (INSTALL_STAGE_COUNT entries).
  statuses: StageStatus[];
  // The plugin id, for the "Unpack & install" stage's ~/.roubo/plugins/<id> meta.
  pluginId: string;
  // The "Download built artifact" stage's meta line (the artifact filename).
  artifactLabel: string;
  // The error code of the failure (if any), so the failed stage's message is
  // accurate when several codes route to the same stage (e.g. unpack-failed vs
  // integrity-failed both surface on the digest stage). Optional: when absent the
  // stage's default fail-closed message is used.
  errorCode?: InstallErrorCode;
  // The server's exact refusal message, when available (e.g. "Rejected tarball:
  // unsupported entry type ..." or "Could not read the release asset tarball:
  // ..."). Rendered under the stage's fail-closed reassurance text so the
  // specific cause is never hidden behind the generic per-stage wording.
  errorDetail?: string;
}

export default function MarketplaceInstallProgress({
  statuses,
  pluginId,
  artifactLabel,
  errorCode,
  errorDetail,
}: Props) {
  const metas = [artifactLabel, "ed25519", "sha256", `~/.roubo/plugins/${pluginId}`];

  return (
    <div
      data-testid="marketplace-install-progress"
      className="overflow-hidden rounded-lg border border-border"
    >
      {Array.from({ length: INSTALL_STAGE_COUNT }, (_unused, index) => {
        const status: StageStatus = statuses[index] ?? "pending";
        const label = STAGE_LABELS[index];
        const meta = metas[index];
        return (
          <div
            key={label}
            data-testid={`marketplace-install-step-${index}`}
            data-step={index}
            data-status={status}
            className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
          >
            <span
              aria-hidden
              className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border text-11 font-medium ${BADGE_CLASS[status]}`}
            >
              {badgeContent(status, index)}
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-13 ${LABEL_CLASS[status]}`}>{label}</p>
              {status === "failed" && (
                <>
                  <p
                    role="alert"
                    data-testid={`marketplace-install-step-${index}-error`}
                    className="mt-0.5 text-12 text-danger-text"
                  >
                    {stageFailMessage(index, errorCode)}
                  </p>
                  {errorDetail && (
                    <p
                      data-testid={`marketplace-install-step-${index}-detail`}
                      className="mt-0.5 font-mono text-11 text-danger-text"
                    >
                      {errorDetail}
                    </p>
                  )}
                </>
              )}
            </div>
            {status !== "failed" && (
              <span className="shrink-0 font-mono text-11 text-text-secondary">{meta}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
