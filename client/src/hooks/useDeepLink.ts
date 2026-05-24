import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

export function useDeepLink(): void {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
          return;
        }
        if (parsed.hostname === "oauth" && parsed.pathname === "/github/callback") {
          // OAuth completed in the browser and Electron main forwarded the
          // callback URL here. Refetch any cached integration state so the
          // Configure dialog reflects the new credential without a manual
          // Test connection click.
          void queryClient.invalidateQueries({
            queryKey: ["global-plugin-integration", "github-com"],
          });
          void queryClient.invalidateQueries({ queryKey: ["project-integration"] });
          void queryClient.invalidateQueries({ queryKey: ["source-candidates"] });
        }
      } catch {
        // ignore malformed URLs
      }
    });
  }, [navigate, queryClient]);
}
