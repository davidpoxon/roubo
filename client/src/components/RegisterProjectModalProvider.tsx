import { createContext, useContext, useState } from "react";
import RegisterProjectModal from "./RegisterProjectModal";

interface RegisterProjectModalContextValue {
  open: () => void;
}

const RegisterProjectModalContext = createContext<RegisterProjectModalContextValue | null>(null);

export function RegisterProjectModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  const open = () => {
    setOpenCount((c) => c + 1);
    setIsOpen(true);
  };
  return (
    <RegisterProjectModalContext.Provider value={{ open }}>
      {children}
      <RegisterProjectModal key={openCount} isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </RegisterProjectModalContext.Provider>
  );
}

export function useRegisterProjectModal() {
  const ctx = useContext(RegisterProjectModalContext);
  if (!ctx)
    throw new Error("useRegisterProjectModal must be used within RegisterProjectModalProvider");
  return ctx;
}
