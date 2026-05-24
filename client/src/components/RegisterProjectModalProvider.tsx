import { useState } from "react";
import RegisterProjectModal from "./RegisterProjectModal";
import { RegisterProjectModalContext } from "../hooks/useRegisterProjectModal";

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
