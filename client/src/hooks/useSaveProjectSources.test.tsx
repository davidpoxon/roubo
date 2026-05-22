// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useSaveProjectSources } from "./useSaveProjectSources";
import * as api from "../lib/api";
import type { ProjectIntegrationState } from "@roubo/shared";

vi.mock("../lib/api", () => ({
  saveProjectSources: vi.fn(),
}));

const mockedSave = vi.mocked(api.saveProjectSources);

beforeEach(() => {
  vi.resetAllMocks();
});

function fixtureState(): ProjectIntegrationState {
  return {
    effective: { plugin: "github-com", sources: { items: ["org/a"] } },
    committed: null,
    override: { plugin: "github-com", sources: { items: ["org/a"] } },
    plugin: {
      id: "github-com",
      installed: true,
      status: "enabled",
      manifest: { name: "GitHub.com" },
    },
    captionKey: "override-only",
  };
}

describe("useSaveProjectSources", () => {
  it("posts the sources payload and invalidates project-integration on settle", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    mockedSave.mockResolvedValue(fixtureState());

    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    }

    const { result } = renderHook(() => useSaveProjectSources("proj-1"), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync({ items: ["org/a"] });
    });

    expect(mockedSave).toHaveBeenCalledWith("proj-1", { items: ["org/a"] });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["project-integration", "proj-1"],
      });
    });
  });
});
