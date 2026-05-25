import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { ExternalLink, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, startGithubPluginOauth } from "../lib/api";

// WU-031: phase machine for the GitHub OAuth re-consent dialog.
//
//   idle ─Continue→ connecting ─openUrl→ waiting-for-browser
//                                            ├─deep-link ok──→ success
//                                            ├─deep-link err─→ error ─Retry→ idle
//                                            └─Cancel────────→ closes, parent
//                                                              records cancelled
export type OAuthReconsentPhase =
  | "idle"
  | "connecting"
  | "waiting-for-browser"
  | "success"
  | "error";

const PHASE_ANNOUNCEMENTS: Record<OAuthReconsentPhase, string> = {
  idle: "Ready to re-authorize GitHub.",
  connecting: "Opening browser to authorize GitHub.",
  "waiting-for-browser": "Waiting for GitHub authorization to complete.",
  success: "GitHub authorized.",
  error: "GitHub authorization failed.",
};

const SUCCESS_HOLD_MS = 600;

interface OAuthReconsentDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  // Fired after a successful deep-link callback, before the dialog closes.
  onSuccess: () => void;
  // Fired when the user closes mid-flight or GitHub returns an error.
  onCancelled: () => void;
}

export default function OAuthReconsentDialog({
  isOpen,
  onOpenChange,
  onSuccess,
  onCancelled,
}: OAuthReconsentDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={false}
      isKeyboardDismissDisabled
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <Modal className="w-full max-w-md mx-4">
        <Dialog
          className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-2xl outline-none"
          data-testid="oauth-reconsent-dialog"
        >
          {({ close }) => (
            <ReconsentFlow close={close} onSuccess={onSuccess} onCancelled={onCancelled} />
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function ReconsentFlow({
  close,
  onSuccess,
  onCancelled,
}: {
  close: () => void;
  onSuccess: () => void;
  onCancelled: () => void;
}) {
  const [phase, setPhase] = useState<OAuthReconsentPhase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Guards setState after unmount: the outer Configure dialog can close while
  // the deep-link is still in flight. Without this the React 19 dev warnings
  // for "state update on unmounted component" surface and CLAUDE.md requires
  // zero stderr in tests.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Subscribe to deep-link callbacks while the dialog is mounted. The handler
  // only advances state when the URL matches roubo://oauth/github/callback so
  // unrelated deep-links (project navigation, etc.) are ignored.
  useEffect(() => {
    if (!window.roubo) return;
    return window.roubo.onDeepLink((url) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.protocol !== "roubo:") return;
      if (parsed.hostname !== "oauth" || parsed.pathname !== "/github/callback") return;
      if (!mountedRef.current) return;

      const error = parsed.searchParams.get("error");
      if (error) {
        setPhase("error");
        setErrorMessage(prettifyOauthError(error));
        return;
      }

      setPhase("success");
      // Invalidate the data the chip depends on so the next render re-probes.
      // useDeepLink already handles ["global-plugin-integration","github-com"],
      // ["project-integration"], and ["source-candidates"]; the OAuth dialog
      // additionally invalidates the issue list + warnings so the cut-list
      // chip clears on the next pull (AC #6).
      void queryClient.invalidateQueries({ queryKey: ["issues"] });
      void queryClient.invalidateQueries({ queryKey: ["integration-warnings"] });

      const timer = setTimeout(() => {
        if (!mountedRef.current) return;
        onSuccess();
        close();
      }, SUCCESS_HOLD_MS);
      // Best-effort cleanup if the dialog unmounts during the hold.
      return () => clearTimeout(timer);
    });
  }, [queryClient, onSuccess, close]);

  async function handleContinue() {
    if (!mountedRef.current) return;
    setPhase("connecting");
    setErrorMessage(null);
    try {
      const { url } = await startGithubPluginOauth();
      // Mirror the existing GithubOauthSection: window.open is routed to the
      // system browser by the Electron windowOpenHandler. Note: the URL is
      // never logged anywhere (NFR: OAuth authorize URL never written to
      // plugin logs); the server endpoint that builds it does not log either.
      window.open(url, "_blank", "noopener,noreferrer");
      if (!mountedRef.current) return;
      setPhase("waiting-for-browser");
    } catch (err) {
      if (!mountedRef.current) return;
      setPhase("error");
      setErrorMessage(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  function handleCancel() {
    onCancelled();
    close();
  }

  return (
    <div className="flex flex-col gap-3 p-5">
      <Heading slot="title" className="text-base font-semibold text-stone-900 dark:text-stone-100">
        Re-authorize GitHub
      </Heading>
      <p className="text-[13px] leading-relaxed text-stone-600 dark:text-stone-400">
        Roubo needs the <code className="font-mono text-[12px]">security_events</code> scope on your
        GitHub token to read Code Scanning, Secret Scanning, and Dependabot alerts. Continue to
        GitHub to grant access. Your browser will open; come back here when you&apos;re done.
      </p>

      {phase === "waiting-for-browser" && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-stone-100 dark:bg-stone-800/60 text-[12px] text-stone-700 dark:text-stone-300">
          <Loader2 size={14} className="animate-spin shrink-0" aria-hidden />
          Waiting for the GitHub authorization to complete in your browser…
        </div>
      )}

      {phase === "success" && (
        <div
          role="status"
          className="flex items-center gap-2 px-3 py-2 rounded-md bg-emerald-50 dark:bg-emerald-900/20 text-[12px] text-emerald-700 dark:text-emerald-300"
        >
          <CheckCircle2 size={14} className="shrink-0" aria-hidden />
          GitHub authorized. Refreshing alerts…
        </div>
      )}

      {phase === "error" && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 rounded-md bg-red-50 dark:bg-red-900/20 text-[12px] text-red-700 dark:text-red-300"
        >
          <AlertCircle size={14} className="shrink-0 mt-0.5" aria-hidden />
          <span>{errorMessage ?? "Authorization failed."}</span>
        </div>
      )}

      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="oauth-reconsent-live-region"
      >
        {phase === "error" && errorMessage
          ? `${PHASE_ANNOUNCEMENTS.error} ${errorMessage}`
          : PHASE_ANNOUNCEMENTS[phase]}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        {phase === "waiting-for-browser" && (
          <Button
            onPress={handleCancel}
            data-testid="oauth-reconsent-cancel"
            className="px-3 py-1.5 text-xs font-medium rounded-md text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
          >
            Cancel
          </Button>
        )}
        {(phase === "idle" || phase === "connecting" || phase === "error") && (
          <>
            <Button
              onPress={handleCancel}
              isDisabled={phase === "connecting"}
              data-testid="oauth-reconsent-dismiss"
              className="px-3 py-1.5 text-xs font-medium rounded-md text-stone-700 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            >
              Close
            </Button>
            <Button
              onPress={() => void handleContinue()}
              isDisabled={phase === "connecting"}
              data-testid="oauth-reconsent-continue"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-amber-500 text-stone-900 hover:bg-amber-400 disabled:opacity-50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-1"
            >
              {phase === "connecting" ? (
                <Loader2 size={12} className="animate-spin" aria-hidden />
              ) : (
                <ExternalLink size={12} aria-hidden />
              )}
              {phase === "error" ? "Retry" : "Continue to GitHub"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function prettifyOauthError(code: string): string {
  switch (code) {
    case "access_denied":
      return "Access was denied in the GitHub authorization page.";
    case "application_suspended":
      return "The Roubo GitHub OAuth app is suspended.";
    case "redirect_uri_mismatch":
      return "GitHub rejected the callback URL. Check the Roubo install.";
    default:
      return `Authorization failed (${code}).`;
  }
}
