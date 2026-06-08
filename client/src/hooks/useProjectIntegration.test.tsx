// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    saveIntegrationConfig: vi.fn(),
  };
});

import * as api from "../lib/api";
import { useSaveIntegrationConfig } from "./useProjectIntegration";

const mockedApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useSaveIntegrationConfig", () => {
  it("invalidates the cut-list and integration queries after a successful save (issue #435)", async () => {
    mockedApi.saveIntegrationConfig.mockResolvedValue({} as never);
    const queryClient = makeQueryClient();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHookWithProviders(() => useSaveIntegrationConfig("demo"), {
      queryClient,
    });

    await result.current.mutateAsync({ excludedStatusCategories: ["Done"] });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["issues"] });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["project-integration", "demo"] });
  });
});
