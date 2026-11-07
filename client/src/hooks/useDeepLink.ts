import { useEffect } from "react";
import { useNavigate } from "react-router";

// The fragment of a bench route that opens its Delivery tab on the decision
// pile (SB-FR-014), as a delivery-decision notification's link asks.
export const DECISION_PILE_HASH = "#decisions";

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
          const toBench =
            parts.length >= 3 &&
            parts[1] === "bench" &&
            ID_RE.test(parts[0]) &&
            ID_RE.test(parts[2]);
          if (!toBench) return;
          const bench = `/projects/${parts[0]}/benches/${parts[2]}`;
          if (parts.length === 3) {
            navigate(bench);
          } else if (parts.length === 4 && parts[3] === "decisions") {
            // A delivery-decision notification links to the decision pile.
            navigate(`${bench}${DECISION_PILE_HASH}`);
          }
        }
      } catch {
        // ignore malformed URLs
      }
    });
  }, [navigate]);
}
