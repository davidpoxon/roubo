import { describe, expect, it } from "vitest";
import { marketplaceQueryKey } from "./useMarketplace";

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
