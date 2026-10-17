import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

// Server-level conditions are settled before the server listens and hold until
// it restarts, so one fetch per window is enough.
export function useSystemStatus() {
  return useQuery({
    queryKey: ["system-status"],
    queryFn: api.fetchSystemStatus,
    staleTime: Infinity,
  });
}
