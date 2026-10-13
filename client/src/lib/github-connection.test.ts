import { describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateGithubConnectionQueries } from "./github-connection";

describe("invalidateGithubConnectionQueries", () => {
  it("invalidates every cached view of the github-com credential", () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();

    invalidateGithubConnectionQueries(queryClient);

    expect(spy.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ["plugin-connection-status", "github-com"],
      ["global-plugin-integration", "github-com"],
      ["project-integration"],
      ["source-candidates"],
      ["issues"],
      ["integration-warnings"],
    ]);
  });
});
