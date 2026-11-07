import { useEffect } from "react";
import { useNavigate } from "react-router";

// The fragment of a bench route that opens its Delivery tab on the decision
// pile (SB-FR-014), as a delivery-decision notification's link asks.
export const DECISION_PILE_HASH = "#decisions";

// The fragment of a bench route that opens a Spec Bench on its Test bench tab,
// where its gate sitting is, as a delivery-sitting notification's link asks
// (SB-FR-023, SB-US-009).
export const GATE_SITTING_HASH = "#sitting";

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
          } else if (parts.length === 4 && parts[3] === "sitting") {
            // A delivery-sitting notification links to the gate sitting.
            navigate(`${bench}${GATE_SITTING_HASH}`);
          }
        }
      } catch {
        // ignore malformed URLs
      }
    });
  }, [navigate]);
}
