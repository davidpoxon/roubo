import { useEffect } from "react";
import { useNavigate } from "react-router";

export function useDeepLink(): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!window.roubo) return;
    return window.roubo.onDeepLink((url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "roubo:") return;
        if (parsed.hostname === "project") {
          const parts = parsed.pathname.split("/").filter(Boolean);
          const ID_RE = /^[\w-]+$/;
          if (
            parts.length === 3 &&
            parts[1] === "bench" &&
            ID_RE.test(parts[0]) &&
            ID_RE.test(parts[2])
          ) {
            navigate(`/projects/${parts[0]}/benches/${parts[2]}`);
          }
        }
      } catch {
        // ignore malformed URLs
      }
    });
  }, [navigate]);
}
