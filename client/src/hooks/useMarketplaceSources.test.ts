// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import {
  marketplaceSourcesQueryKey,
  useMarketplaceSources,
  useRemoveMarketplaceSource,
} from "./useMarketplaceSources";
import { useMarketplaceCatalog } from "./useMarketplace";
import type { MarketplaceCatalogResponse, MarketplaceSourceSummary } from "@roubo/shared";

vi.mock("../lib/api");
import * as api from "../lib/api";

const fetchMarketplaceSources = vi.mocked(api.fetchMarketplaceSources);
const removeMarketplaceSource = vi.mocked(api.removeMarketplaceSource);
const fetchMarketplaceCatalog = vi.mocked(api.fetchMarketplaceCatalog);

// The Marketplaces settings section (issue #561) reads the registry through this
// hook. Removing a source changes which listings the merged Browse catalog
// serves, so the mutation must invalidate the catalog query too, not only the
// source list. Registration is covered in useMarketplace.test.ts, next to the
// useRegisterMarketplaceSource hook that owns it (issue #562).

const ACME: MarketplaceSourceSummary = {
  id: "marketplace-acme-example-1a2b3c4d",
  url: "https://marketplace.acme.example/catalog.json",
  hasCredential: true,
  registeredAt: "2026-07-15T09:30:00.000Z",
};

const CATALOG: MarketplaceCatalogResponse = {
  curated: true,
  listings: [],
  source: "network",
  fetchedAt: "2026-07-15T09:30:00.000Z",
  sources: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("marketplaceSourcesQueryKey", () => {
  it("is a stable, unparameterised key (the list is never filtered)", () => {
    expect(marketplaceSourcesQueryKey()).toEqual(["marketplace-sources"]);
  });
});

describe("useMarketplaceSources", () => {
  it("returns the registered sources as the server listed them", async () => {
    const sources = [
      { id: "first-party", url: "https://roubo.dev/catalog.json" } as MarketplaceSourceSummary,
      ACME,
    ];
    fetchMarketplaceSources.mockResolvedValue({ sources });

    const { result } = renderHookWithProviders(() => useMarketplaceSources());
    await waitFor(() => expect(result.current.data).toEqual({ sources }));
  });

  it("surfaces a fetch failure to the caller", async () => {
    fetchMarketplaceSources.mockRejectedValue(new Error("offline"));

    const { result } = renderHookWithProviders(() => useMarketplaceSources());
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
  });
});

describe("useRemoveMarketplaceSource", () => {
  it("deletes by id and refreshes the source list and the catalog", async () => {
    fetchMarketplaceSources.mockResolvedValue({ sources: [ACME] });
    fetchMarketplaceCatalog.mockResolvedValue(CATALOG);
    removeMarketplaceSource.mockResolvedValue(undefined);

    const { result } = renderHookWithProviders(() => ({
      remove: useRemoveMarketplaceSource(),
      list: useMarketplaceSources(),
      catalog: useMarketplaceCatalog({}),
    }));
    await waitFor(() => expect(result.current.list.data).toEqual({ sources: [ACME] }));
    await waitFor(() => expect(fetchMarketplaceCatalog).toHaveBeenCalledTimes(1));

    fetchMarketplaceSources.mockResolvedValue({ sources: [] });
    result.current.remove.mutate(ACME.id);

    await waitFor(() => expect(result.current.remove.isSuccess).toBe(true));
    expect(removeMarketplaceSource).toHaveBeenCalledWith(ACME.id);
    await waitFor(() => expect(result.current.list.data).toEqual({ sources: [] }));
    // Removing a source drops its listings from Browse, so the catalog must
    // refetch here too, not just the source list.
    await waitFor(() => expect(fetchMarketplaceCatalog).toHaveBeenCalledTimes(2));
  });
});
