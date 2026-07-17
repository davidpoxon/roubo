// @vitest-environment jsdom
//
// The shared trust badge's rendering (CPHMTP-FR-006 / CPHMTP-NFR-001, issue
// #563): which pills each trust treatment produces, that source provenance always
// accompanies the badge, and that there is no dismiss affordance to find
// (CPHMTP-TC-041). The trust DECISION this renders is pinned separately in
// plugin-provenance.test.ts.

import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceListing } from "@roubo/shared";
import ProvenanceBadge from "./ProvenanceBadge";
import { FIRST_PARTY_LABEL, listingProvenance, type PluginProvenance } from "./plugin-provenance";

const ACME_SOURCE_ID = "marketplace-acme-example-1a2b3c4d";
const ACME_LABEL = "ACME workplace";

function provenance(over: Partial<PluginProvenance> = {}): PluginProvenance {
  return {
    sourceId: FIRST_PARTY_SOURCE_ID,
    sourceLabel: FIRST_PARTY_LABEL,
    curated: true,
    orphaned: false,
    ...over,
  };
}

function listing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: "ghe",
    name: "GitHub Enterprise",
    kind: "integration",
    version: "1.0.0",
    summary: "Connect a self-hosted GitHub Enterprise instance.",
    source: { type: "git", url: "https://example.com/ghe.git" },
    provenance: "acme/plugins@ghe",
    integrity: "sha256-ghe",
    verified: false,
    installed: false,
    installedVersion: null,
    updateAvailable: false,
    declaredPermissions: null,
    lifecycle: null,
    sourceId: ACME_SOURCE_ID,
    ...over,
  };
}

describe("ProvenanceBadge rendering (CPHMTP-TC-030 / CPHMTP-TC-056)", () => {
  it("renders the Unverified pill and the source provenance for a third-party plugin", () => {
    render(
      <ProvenanceBadge
        provenance={provenance({
          sourceId: ACME_SOURCE_ID,
          sourceLabel: ACME_LABEL,
          curated: false,
        })}
      />,
    );
    const trust = screen.getByTestId("provenance-trust");
    expect(trust).toHaveTextContent("Unverified");
    expect(trust.dataset.treatment).toBe("unverified");
    // CPHMTP-TC-030 S001-O02: no first-party verified treatment anywhere on it.
    expect(trust.className).toContain("amber");
    expect(trust.className).not.toContain("green");
    expect(trust).not.toHaveTextContent("first-party");
    // CPHMTP-TC-056 S001-O02: the badge is accompanied by source provenance.
    expect(screen.getByTestId("provenance-source")).toHaveTextContent("Source: ACME workplace");
  });

  it("renders the Verified first-party treatment for a curated first-party plugin", () => {
    render(<ProvenanceBadge provenance={provenance()} />);
    const trust = screen.getByTestId("provenance-trust");
    expect(trust).toHaveTextContent("Verified · first-party");
    expect(trust.dataset.treatment).toBe("verified");
    expect(trust.className).toContain("green");
    expect(trust.className).not.toContain("amber");
    // CPHMTP-TC-030 S002-O02: a first-party entry shows no Unverified pill.
    expect(trust).not.toHaveTextContent("Unverified");
    expect(screen.getByTestId("provenance-source")).toHaveTextContent("Source: Roubo first-party");
  });

  // CPHMTP-TC-072 S001-O02 at the render layer: the injected claim reaches the
  // component and still cannot buy the green treatment.
  it("renders Unverified for a hostile listing that injects verified: true", () => {
    const hostile = listing({ verified: true, sourceId: ACME_SOURCE_ID });
    render(<ProvenanceBadge provenance={listingProvenance(hostile, ACME_LABEL)} />);
    const trust = screen.getByTestId("provenance-trust");
    expect(trust).toHaveTextContent("Unverified");
    expect(trust.className).not.toContain("green");
    expect(screen.getByTestId("provenance-source")).toHaveTextContent(ACME_LABEL);
  });

  it("renders both the Orphaned and Unverified pills for an orphaned third-party plugin", () => {
    render(
      <ProvenanceBadge
        provenance={provenance({ sourceId: ACME_SOURCE_ID, curated: false, orphaned: true })}
      />,
    );
    expect(screen.getByTestId("provenance-orphaned")).toHaveTextContent("Orphaned");
    // CPHMTP-FR-009: the unverified badge is RETAINED through the orphaning.
    expect(screen.getByTestId("provenance-trust")).toHaveTextContent("Unverified");
  });

  it("renders no Orphaned pill for a plugin whose source is still registered", () => {
    render(<ProvenanceBadge provenance={provenance({ sourceId: ACME_SOURCE_ID })} />);
    expect(screen.queryByTestId("provenance-orphaned")).not.toBeInTheDocument();
  });

  // CPHMTP-TC-041 S001-O01: there is no dismiss/hide/close affordance. The badge
  // holds no state at all, which is also why it survives a reload (S002-O01):
  // re-rendering the same provenance always produces the same badge.
  it("exposes no dismiss affordance and re-renders identically (CPHMTP-TC-041)", () => {
    const unverified = provenance({ sourceId: ACME_SOURCE_ID, curated: false });
    const { unmount } = render(<ProvenanceBadge provenance={unverified} />);
    const badge = screen.getByTestId("provenance-badge");
    expect(within(badge).queryByRole("button")).not.toBeInTheDocument();
    expect(badge.querySelector("button")).toBeNull();
    expect(badge.querySelector("[aria-label]")).toBeNull();
    expect(badge.textContent).not.toMatch(/dismiss|hide|close/i);

    // Remount (what a reload does): the badge comes back unchanged, because it is
    // derived from provenance and nothing else.
    const before = badge.innerHTML;
    unmount();
    render(<ProvenanceBadge provenance={unverified} />);
    expect(screen.getByTestId("provenance-badge").innerHTML).toBe(before);
    expect(screen.getByTestId("provenance-trust")).toHaveTextContent("Unverified");
  });

  // Issue #596: the pills are role-less spans (ARIA role `generic`), which cannot
  // carry an aria-label, so their context must be sr-only subtree text.
  it("announces source and warning context as screen-reader-only text, not aria-labels", () => {
    render(
      <ProvenanceBadge
        provenance={provenance({ sourceId: ACME_SOURCE_ID, curated: false, orphaned: true })}
      />,
    );
    const source = screen.getByTestId("provenance-source");
    expect(within(source).getByText("Source:", { exact: false }).className).toContain("sr-only");
    expect(source.getAttribute("aria-label")).toBeNull();
    expect(screen.getByTestId("provenance-trust")).toHaveTextContent(/unsigned source/i);
    expect(screen.getByTestId("provenance-orphaned")).toHaveTextContent(/no update path/i);
  });
});
