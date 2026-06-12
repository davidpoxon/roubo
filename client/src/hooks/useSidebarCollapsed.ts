import { useState, useCallback } from "react";

const STORAGE_KEY = "roubo-sidebar-collapsed";

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function write(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Ignore storage failures (private mode, quota): the toggle still works
    // for the session, it just does not persist.
  }
}

// App-global projects-sidebar collapse (#524). The sidebar is not scoped to a
// bench, so its collapse preference lives in its own top-level key rather than
// the per-bench view-state store. Reads straight from localStorage each render
// and bumps a version counter on write so the value is correct immediately.
export function useSidebarCollapsed() {
  const [, setVersion] = useState(0);

  const collapsed = read();

  const setCollapsed = useCallback((next: boolean) => {
    write(next);
    setVersion((v) => v + 1);
  }, []);

  return { collapsed, setCollapsed };
}
