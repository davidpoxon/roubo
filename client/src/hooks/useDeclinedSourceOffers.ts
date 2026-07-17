import { createContext, useContext } from "react";

// Session-scoped memory of declined project-declared source registration offers
// (CPHMTP-FR-007, issue #565). The context is split out of the provider file so
// the provider module can stay a component-only export (react-refresh), mirroring
// useRegisterProjectModal alongside RegisterProjectModalProvider.

export interface DeclinedSourceOffersContextValue {
  /** True when this project+URL offer was declined earlier in the current session. */
  isDeclined: (projectId: string, normalizedUrl: string) => boolean;
  /** Record a session-scoped decline for this project+URL. */
  decline: (projectId: string, normalizedUrl: string) => void;
}

export const DeclinedSourceOffersContext = createContext<DeclinedSourceOffersContextValue | null>(
  null,
);

export function useDeclinedSourceOffers(): DeclinedSourceOffersContextValue {
  const ctx = useContext(DeclinedSourceOffersContext);
  if (!ctx) {
    throw new Error("useDeclinedSourceOffers must be used within DeclinedSourceOffersProvider");
  }
  return ctx;
}
