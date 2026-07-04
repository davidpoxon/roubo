import { useState } from "react";
import { Button } from "react-aria-components";
import { AlertTriangle, X } from "lucide-react";
import type { ResultsRecoveryReason } from "../../lib/api";

// The DESIGN.md "Attention banner" (amber-50 background, amber-200 border,
// amber-800 message), surfaced when the bench's stored results could not be read
// and were failed open server-side (#417, NFR-003). The server discriminates WHY
// the read recovered (the `ResultsRecoveryReason` added in #896); this banner
// renders only for a reason the user should acknowledge: a corrupt / schema
// invalid file (could not be read), a file from a NEWER Roubo (future-version),
// or one from an EARLIER Roubo that needs migration (version-migration-required).
// A MISSING sidecar is the clean initial state of a fresh bench, so
// null / undefined / "missing" stay silent (TC-047). Unlike the StalenessBanner
// it is DISMISSIBLE (local state, a close control): the server has already failed
// open to a clean slate, so the prompt is an acknowledgement, not an action the
// user must take.
//
// Recovery is computed server-side; this component never decides it, it only
// renders the reason it is handed.
const STRINGS = {
  corrupt:
    "The saved results for this bench could not be read and have been reset to a clean slate.",
  future:
    "The saved results for this bench were written by a newer version of Roubo and could not be read. They have been reset to a clean slate.",
  migration:
    "The saved results for this bench were written by an earlier version of Roubo and need migration. They have been reset to a clean slate.",
  dismiss: "Dismiss",
};

// Map a recovery reason to its prompt message, or null when it should stay silent.
// Exhaustive over ResultsRecoveryReason so a newly added reason is a compile error
// here rather than a silently-dropped prompt.
function messageFor(reason: ResultsRecoveryReason): string | null {
  switch (reason) {
    case "future-version":
      return STRINGS.future;
    case "version-migration-required":
      return STRINGS.migration;
    case "corrupt-json":
    case "schema-invalid":
      return STRINGS.corrupt;
    case "missing":
      return null;
  }
}

export default function ResultsRecoveryBanner({
  recoveryReason,
}: {
  recoveryReason?: ResultsRecoveryReason | null;
}) {
  const [dismissed, setDismissed] = useState(false);

  // A clean read (null), an absent field (older server), or a MISSING sidecar (a
  // fresh bench, the clean initial state) all stay silent.
  if (recoveryReason == null) return null;
  const message = messageFor(recoveryReason);
  if (message === null) return null;
  if (dismissed) return null;

  return (
    <div
      role="status"
      data-testid="results-recovery-banner"
      data-recovery={recoveryReason}
      className="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-200 bg-amber-50"
    >
      <AlertTriangle size={16} className="text-amber-500 shrink-0" aria-hidden />
      <p className="flex-1 min-w-0 text-sm text-amber-800">{message}</p>
      <Button
        onPress={() => setDismissed(true)}
        aria-label={STRINGS.dismiss}
        data-testid="results-recovery-banner-dismiss"
        className="shrink-0 p-1 rounded-md text-amber-800 hover:bg-amber-100 active:bg-amber-200 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-amber-50"
      >
        <X size={16} aria-hidden />
      </Button>
    </div>
  );
}
