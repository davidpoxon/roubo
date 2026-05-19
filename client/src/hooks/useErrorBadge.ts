import { useEffect } from "react";
import type { Bench } from "@roubo/shared";
import { useAllBenches } from "./useBenches";

export function countComponentErrors(benches: Bench[] | undefined): number {
  if (!benches) return 0;
  let n = 0;
  for (const b of benches) {
    for (const c of Object.values(b.components)) {
      if (c.status === "error") n++;
    }
  }
  return n;
}

export function useErrorBadge(): void {
  const { data } = useAllBenches();
  const count = countComponentErrors(data);
  useEffect(() => {
    window.roubo?.setBadgeCount(count);
    return () => {
      window.roubo?.setBadgeCount(0);
    };
  }, [count]);
}
