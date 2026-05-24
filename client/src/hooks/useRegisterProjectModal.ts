import { createContext, useContext } from "react";

export interface RegisterProjectModalContextValue {
  open: () => void;
}

export const RegisterProjectModalContext = createContext<RegisterProjectModalContextValue | null>(
  null,
);

export function useRegisterProjectModal() {
  const ctx = useContext(RegisterProjectModalContext);
  if (!ctx)
    throw new Error("useRegisterProjectModal must be used within RegisterProjectModalProvider");
  return ctx;
}
