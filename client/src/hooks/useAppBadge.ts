import { useEffect } from "react";
import { useAllBenches } from "./useBenches";
import { collectActionNeeded } from "../lib/notifications";

export function useAppBadge(): void {
  const { data } = useAllBenches();
  const count = collectActionNeeded(data ?? []).length;
  useEffect(() => {
    window.roubo?.setBadgeCount(count);
  }, [count]);
  // Reset badge only on unmount — separate effect avoids a 0-frame flicker
  // that occurs when React runs the cleanup of the count effect before the
  // next effect fires on every count update.
  useEffect(() => {
    return () => {
      window.roubo?.setBadgeCount(0);
    };
  }, []);
}
