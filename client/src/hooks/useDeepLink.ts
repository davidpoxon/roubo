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
          // Test connection click. Also bust the cut list and per-source
          // warnings so a re-consent flow (WU-039) immediately hides the
          // inline affordance and surfaces freshly-permitted alerts.
          //
          // The live connection-status query uses staleTime: Infinity and only
          // refetches when its key is invalidated. Without this, a
          // disconnect-then-reconnect keeps serving the stale "disconnected"
          // status, so the Configure dialog stays on "Connect GitHub" even
          // though the token was saved. Mirror the disconnect path, which
          // invalidates the same key.
          void queryClient.invalidateQueries({
            queryKey: ["plugin-connection-status", "github-com"],
          });
          void queryClient.invalidateQueries({
            queryKey: ["global-plugin-integration", "github-com"],
          });
          void queryClient.invalidateQueries({ queryKey: ["project-integration"] });
          void queryClient.invalidateQueries({ queryKey: ["source-candidates"] });
          void queryClient.invalidateQueries({ queryKey: ["issues"] });
          void queryClient.invalidateQueries({ queryKey: ["integration-warnings"] });
        }
      } catch {
        // ignore malformed URLs
      }
    });
  }, [navigate, queryClient]);
}
