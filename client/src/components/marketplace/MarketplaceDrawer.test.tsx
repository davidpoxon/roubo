// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceListing } from "@roubo/shared";
import MarketplaceDrawer from "./MarketplaceDrawer";

function listing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: "redis",
    name: "Redis",
    kind: "component",
    version: "1.3.0",
    summary: "A Redis cache component.",
    source: { type: "git", url: "https://example.com/r.git" },
    provenance: "roubo/plugins@redis",
    integrity: "sha256-redis",
    verified: true,
    installed: false,
    installedVersion: null,
    updateAvailable: false,
    declaredPermissions: null,
    lifecycle: null,
    sourceId: FIRST_PARTY_SOURCE_ID,
    ...over,
  };
}

describe("MarketplaceDrawer", () => {
  it("renders the entry detail in a dialog", () => {
    render(
      <MarketplaceDrawer
        listing={listing()}
        sourceLabel="Roubo first-party"
        onClose={vi.fn()}
        onInstall={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByRole("heading", { name: /plugin detail/i })).toBeInTheDocument();
    expect(screen.getByText("Redis")).toBeInTheDocument();
  });

  // Issue #612 / #424: React Aria omits aria-modal and strips the prop, so the
  // shared stampAriaModal ref is what makes the modality explicit to AT.
  it("stamps aria-modal on the dialog", () => {
    render(
      <MarketplaceDrawer
        listing={listing()}
        sourceLabel="Roubo first-party"
        onClose={vi.fn()}
        onInstall={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });
});
