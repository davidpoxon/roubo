import { describe, it, expect } from "vitest";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary } from "@roubo/shared";
import { sourceDisplayName } from "./marketplace-source-name";

const FIRST_PARTY: MarketplaceSourceSummary = {
  id: FIRST_PARTY_SOURCE_ID,
  url: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
  hasCredential: false,
  registeredAt: "1970-01-01T00:00:00.000Z",
};

const ACME: MarketplaceSourceSummary = {
  id: "marketplace-acme-example-1a2b3c4d",
  url: "https://marketplace.acme.example/catalog.json",
  hasCredential: true,
  registeredAt: "2026-07-15T09:30:00.000Z",
};

describe("sourceDisplayName", () => {
  it("names the built-in row from its reserved id", () => {
    expect(sourceDisplayName(FIRST_PARTY)).toBe("Roubo first-party");
  });

  it("uses the reserved id, not the URL, to recognise the built-in row", () => {
    // Same URL as the built-in, but a third-party id: still a third-party name,
    // so a source registered at the first-party URL cannot borrow its identity.
    expect(sourceDisplayName({ ...FIRST_PARTY, id: "marketplace-imposter-deadbeef" })).toBe(
      "davidpoxon.github.io",
    );
  });

  it("derives a third-party name from the URL host", () => {
    expect(sourceDisplayName(ACME)).toBe("marketplace.acme.example");
  });

  it("keeps the port when the host carries one", () => {
    expect(sourceDisplayName({ ...ACME, url: "https://ghe.acme.internal:8443/catalog.json" })).toBe(
      "ghe.acme.internal:8443",
    );
  });

  it("falls back to the raw string when the URL cannot be parsed", () => {
    expect(sourceDisplayName({ ...ACME, url: "not a url" })).toBe("not a url");
  });
});
