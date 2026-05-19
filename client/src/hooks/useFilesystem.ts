import { useQuery } from "@tanstack/react-query";
import * as api from "../lib/api";

export function useBrowseDirectory(
  path: string | undefined,
  showHidden: boolean,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["filesystem", "browse", path ?? "~", showHidden],
    queryFn: () => api.browseDirectory(path, showHidden),
    enabled,
    staleTime: 10_000,
  });
}
