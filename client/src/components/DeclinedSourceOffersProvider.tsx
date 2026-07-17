import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  DeclinedSourceOffersContext,
  type DeclinedSourceOffersContextValue,
} from "../hooks/useDeclinedSourceOffers";

// In-memory, per-session memory of declined project-declared source registration
// offers (CPHMTP-FR-007, issue #565). A decline is keyed `projectId + '\0' +
// normalizedUrl` and held in a plain in-process Set: it survives navigating away
// from a project and back within the same app run (CPHMTP-TC-078), yet resets on
// a fresh launch so the offer re-appears in a later session (CPHMTP-TC-087).
//
// It is deliberately NOT persisted to localStorage/sessionStorage: persisting a
// decline would make it permanent and defeat the re-offer, and the trust decision
// is meant to be reconsidered each session. Mirrors the in-memory-Set shape of
// TeardownTrackerProvider and the context split of RegisterProjectModalProvider.

// The NUL separator cannot appear in a projectId or a WHATWG-normalised href, so
// the composite key is unambiguous.
function offerKey(projectId: string, normalizedUrl: string): string {
  return `${projectId}\0${normalizedUrl}`;
}

export function DeclinedSourceOffersProvider({ children }: { children: ReactNode }) {
  const [declined, setDeclined] = useState<Set<string>>(() => new Set());

  const decline = useCallback((projectId: string, normalizedUrl: string) => {
    setDeclined((prev) => {
      const k = offerKey(projectId, normalizedUrl);
      if (prev.has(k)) return prev;
      const next = new Set(prev);
      next.add(k);
      return next;
    });
  }, []);

  // Deriving isDeclined from the `declined` state (not a ref) is what re-renders
  // consumers when a decline lands, so the banner disappears the instant "Not
  // now" is pressed.
  const value = useMemo<DeclinedSourceOffersContextValue>(
    () => ({
      isDeclined: (projectId, normalizedUrl) => declined.has(offerKey(projectId, normalizedUrl)),
      decline,
    }),
    [declined, decline],
  );

  return (
    <DeclinedSourceOffersContext.Provider value={value}>
      {children}
    </DeclinedSourceOffersContext.Provider>
  );
}
