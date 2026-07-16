// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { marketplaceQueryKey, useMarketplaceCatalog } from "./useMarketplace";
import type { MarketplaceCatalogResponse } from "@roubo/shared";

vi.mock("../lib/api");
import * as api from "../lib/api";

const fetchMarketplaceCatalog = vi.mocked(api.fetchMarketplaceCatalog);

// The marketplace catalog query is cached per filter combination, so the key has
// to carry every param that changes the server's answer. Issue #557 added the
// source filter (sourceId): without it in the key, scoping the merged list to one
// source would read back another source's cached listings.

describe("marketplaceQueryKey", () => {
  it("defaults every absent filter to its unscoped sentinel", () => {
    expect(marketplaceQueryKey({})).toEqual(["marketplace", "", "all", "all"]);
  });

  it("carries q, kind, and sourceId", () => {
    expect(
      marketplaceQueryKey({ q: "ghe", kind: "integration", sourceId: "acme-1a2b3c4d" }),
    ).toEqual(["marketplace", "ghe", "integration", "acme-1a2b3c4d"]);
  });

  it("distinguishes two sources that differ only by sourceId", () => {
    const firstParty = marketplaceQueryKey({ sourceId: "first-party" });
    const acme = marketplaceQueryKey({ sourceId: "acme-1a2b3c4d" });
    expect(firstParty).not.toEqual(acme);
  });

  it("distinguishes an unscoped list from a list scoped to one source", () => {
    expect(marketplaceQueryKey({})).not.toEqual(marketplaceQueryKey({ sourceId: "acme-1a2b3c4d" }));
  });
});

// The Browse screen renders the source filter chips from the catalog response
// itself, and sourceId is part of the query key, so a chip click starts a fresh
// query. Without previous data held across that key change the response would go
// undefined mid-flight and the chip row would unmount under the user, taking
// keyboard focus and the "All sources" way back with it (issue #557).
describe("useMarketplaceCatalog", () => {
  function response(over: Partial<MarketplaceCatalogResponse> = {}): MarketplaceCatalogResponse {
    return {
      curated: true,
      listings: [],
      source: "network",
      fetchedAt: "2026-07-02T00:00:00.000Z",
      sources: [
        {
          id: "first-party",
          url: "https://roubo.dev/catalog.json",
          label: "Roubo first-party",
          source: "network",
          fetchedAt: "2026-07-02T00:00:00.000Z",
          unavailable: false,
        },
      ],
      ...over,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("holds the previous response while a newly scoped query is in flight", async () => {
    const merged = response();
    fetchMarketplaceCatalog.mockResolvedValueOnce(merged);
    const { result, rerender } = renderHookWithProviders(
      ({ sourceId }: { sourceId?: string }) => useMarketplaceCatalog({ sourceId }),
      { initialProps: {} as { sourceId?: string } },
    );
    await waitFor(() => expect(result.current.data).toEqual(merged));

    // Scope to one source: a new key, and a request that has not resolved yet.
    let resolveScoped: (r: MarketplaceCatalogResponse) => void = () => {};
    fetchMarketplaceCatalog.mockReturnValueOnce(
      new Promise<MarketplaceCatalogResponse>((r) => {
        resolveScoped = r;
      }),
    );
    rerender({ sourceId: "acme-1a2b3c4d" });

    // The chips render from data.sources, so data must survive the key change.
    expect(result.current.data).toEqual(merged);

    // Distinguishable from the placeholder, so this can only pass once the scoped
    // response has actually replaced the held data.
    const scoped = response({ fetchedAt: "2026-07-03T00:00:00.000Z", sources: merged.sources });
    resolveScoped(scoped);
    await waitFor(() => expect(result.current.data).toEqual(scoped));
    expect(result.current.data).not.toEqual(merged);
  });
});
