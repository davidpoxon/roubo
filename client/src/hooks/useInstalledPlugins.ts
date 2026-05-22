import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useInstalledPlugins(enabled = true) {
  return useQuery({
    queryKey: ["plugins"],
    queryFn: api.fetchInstalledPlugins,
    enabled,
    staleTime: 30_000,
  });
}
