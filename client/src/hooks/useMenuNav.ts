import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const MENU_NAV_ALLOWLIST = new Set(["/settings", "/updates"]);

export function useMenuNav(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!window.roubo) return;
    return window.roubo.onNavigate((path) => {
      if (MENU_NAV_ALLOWLIST.has(path)) {
        navigate(path);
      }
    });
  }, [navigate]);
}
