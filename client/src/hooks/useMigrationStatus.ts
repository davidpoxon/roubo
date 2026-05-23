import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

// One-shot fetch of /api/migration/status. The migration record is set once at
// server boot (WU-024 / issue #42); it doesn't change while the app is running,
// so no polling.
export function useMigrationStatus() {
  return useQuery({
    queryKey: ["migration-status"],
    queryFn: api.fetchMigrationStatus,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
}
