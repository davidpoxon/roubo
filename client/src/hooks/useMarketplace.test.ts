// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { waitFor } from "@testing-library/react";
import { makeQueryClient, renderHookWithProviders } from "../test/renderWithProviders";
import {
  marketplaceQueryKey,
  useMarketplaceCatalog,
  useRegisterMarketplaceSource,
} from "./useMarketplace";
import { useMarketplaceSources } from "./useMarketplaceSources";
import type { MarketplaceCatalogResponse } from "@roubo/shared";

vi.mock("../lib/api");
import * as api from "../lib/api";

const fetchMarketplaceCatalog = vi.mocked(api.fetchMarketplaceCatalog);
const registerMarketplaceSource = vi.mocked(api.registerMarketplaceSource);
const fetchMarketplaceSources = vi.mocked(api.fetchMarketplaceSources);

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

// Registering a third-party marketplace source (CPHMTP-FR-002, issue #562). The
// mutation is the consent write: it must run only when the dialog's container
// fires it, and a new source changes the merged catalog and its `sources` array,
// so the marketplace key tree has to be re-read afterwards.
describe("useRegisterMarketplaceSource", () => {
  const created = {
    id: "marketplace-acme-example-1a2b3c4d",
    url: "https://marketplace.acme.example/catalog.json",
    hasCredential: false,
    registeredAt: "2026-07-02T00:00:00.000Z",
  };

  beforeEach(() => {
    registerMarketplaceSource.mockReset();
  });

  it("registers nothing until the mutation is fired (CPHMTP-NFR-003)", () => {
    renderHookWithProviders(() => useRegisterMarketplaceSource());
    expect(registerMarketplaceSource).not.toHaveBeenCalled();
  });

  it("passes the consented url, credential, and allow-http opt-in through", async () => {
    registerMarketplaceSource.mockResolvedValue({ ...created, hasCredential: true });
    const { result } = renderHookWithProviders(() => useRegisterMarketplaceSource());

    result.current.mutate({ url: created.url, credential: "tok-abc", allowHttp: true });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(registerMarketplaceSource).toHaveBeenCalledWith({
      url: created.url,
      credential: "tok-abc",
      allowHttp: true,
    });
    expect(result.current.data).toEqual({ ...created, hasCredential: true });
  });

  it("invalidates the marketplace key tree once a source is registered", async () => {
    registerMarketplaceSource.mockResolvedValue(created);
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useRegisterMarketplaceSource(), {
      queryClient,
    });

    result.current.mutate({ url: created.url });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["marketplace"] });
  });

  it("refetches the Marketplaces settings list once a source is registered (issue #561)", async () => {
    // The settings list is keyed ["marketplace-sources"], a sibling of the
    // ["marketplace"] prefix rather than a child, so the key-tree invalidation
    // above does NOT reach it. Assert the real refetch: a spy on invalidateQueries
    // would pass even if the key never matched a live query.
    registerMarketplaceSource.mockResolvedValue(created);
    fetchMarketplaceSources.mockResolvedValue({ sources: [] });

    const { result } = renderHookWithProviders(() => ({
      register: useRegisterMarketplaceSource(),
      list: useMarketplaceSources(),
    }));
    await waitFor(() => expect(result.current.list.data).toEqual({ sources: [] }));

    fetchMarketplaceSources.mockResolvedValue({ sources: [created] });
    result.current.register.mutate({ url: created.url });

    await waitFor(() => expect(result.current.register.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.list.data).toEqual({ sources: [created] }));
  });

  it("does not invalidate when the registration is refused", async () => {
    registerMarketplaceSource.mockRejectedValue(new Error("Invalid source URL"));
    const queryClient = makeQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHookWithProviders(() => useRegisterMarketplaceSource(), {
      queryClient,
    });

    result.current.mutate({ url: "not-a-url" });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(invalidate).not.toHaveBeenCalled();
  });
});
