import { useState } from "react";
import { Button } from "react-aria-components";
import { AlertTriangle, X } from "lucide-react";
import type { LoginShellImportStatus } from "@roubo/shared";
import { useSystemStatus } from "../hooks/useSystemStatus";

// App-wide band for a server condition that degrades every bench until Roubo
// restarts (#1487). Today that is one condition: the boot-time import of the
// login-shell environment failed, so terminals and agent sessions run on the
// launch environment's minimal PATH. The log alone hid this, and the symptom
// ("command not found" inside a session) points nowhere near the cause.
//
// An attention banner in the ProjectDeclaredSourceOffer position and style: the
// accent-muted ground, accent-border edge, and accent-text message, with an
// AlertTriangle marker. It names the cause and the cure. Dismissing hides it for
// this window only, since the condition itself lasts until a restart.

type FailedImport = Extract<LoginShellImportStatus, { state: "failed" }>;

const STRINGS = {
  label: "Shell environment not loaded",
  cause: (status: FailedImport) =>
    status.reason === "timeout"
      ? `Roubo could not load your shell environment: ${status.shell} did not start within ${Math.round(status.timeoutMs / 1000)} s.`
      : `Roubo could not load your shell environment: running ${status.shell} failed.`,
  effect:
    "Terminals and AI coding agent sessions are running with a minimal PATH, so tools that your shell profile sets up may be missing.",
  cure: "Quit and reopen Roubo to load it again. If this keeps happening, check that your shell profile starts quickly and without errors.",
  dismiss: "Dismiss",
};

export default function SystemStatusBanner() {
  const { data } = useSystemStatus();
  const [dismissed, setDismissed] = useState(false);

  const status = data?.loginShellImport;
  if (dismissed || status?.state !== "failed") return null;

  return (
    <div
      role="status"
      aria-label={STRINGS.label}
      data-testid="login-shell-import-banner"
      data-reason={status.reason}
      className="flex items-start gap-3 border-b border-accent-border bg-accent-muted px-4 py-2.5 text-accent-text"
    >
      <AlertTriangle size={16} className="shrink-0 mt-0.5 text-accent-text" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-13 leading-relaxed">{STRINGS.cause(status)}</p>
        <p className="mt-1 text-13 leading-relaxed">{STRINGS.effect}</p>
        <p className="mt-1 text-13 leading-relaxed">{STRINGS.cure}</p>
        <p className="mt-1 font-mono text-12 break-all text-accent-text">{status.detail}</p>
      </div>
      <Button
        onPress={() => setDismissed(true)}
        aria-label={STRINGS.dismiss}
        data-testid="login-shell-import-banner-dismiss"
        className="shrink-0 p-1 rounded-control text-accent-text hover:bg-accent-muted transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <X size={16} aria-hidden="true" />
      </Button>
    </div>
  );
}
