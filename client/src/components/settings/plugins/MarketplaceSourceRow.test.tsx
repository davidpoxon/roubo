// @vitest-environment jsdom
//
// CPHMTP-FR-001 / CPHMTP-TC-001, CPHMTP-TC-004 (issue #561): one row's
// provenance rendering, and the structural guarantee that the built-in
// first-party row exposes no removal affordance.

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary } from "@roubo/shared";
import MarketplaceSourceRow from "./MarketplaceSourceRow";

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

function renderRow(source: MarketplaceSourceSummary, onRemove = vi.fn()) {
  const utils = render(
    <ul>
      <MarketplaceSourceRow source={source} onRemove={onRemove} />
    </ul>,
  );
  return { ...utils, onRemove };
}

describe("MarketplaceSourceRow: first-party (TC-001 S002, TC-004 S002)", () => {
  it("names the built-in row and marks it verified, first-party", () => {
    renderRow(FIRST_PARTY);
    expect(screen.getByText("Roubo first-party")).toBeInTheDocument();
    const pill = screen.getByTestId("marketplace-source-pill");
    expect(pill).toHaveTextContent("Verified, first-party");
    expect(pill.getAttribute("data-verified")).toBe("true");
  });

  it("reads 'Built in · signed catalog · cannot be removed' and shows the raw URL", () => {
    renderRow(FIRST_PARTY);
    expect(screen.getByTestId("marketplace-source-meta")).toHaveTextContent(
      "Built in · signed catalog · cannot be removed",
    );
    expect(screen.getByTestId("marketplace-source-url")).toHaveTextContent(FIRST_PARTY.url);
  });

  it("exposes NO Remove control at all, not merely a disabled one", () => {
    renderRow(FIRST_PARTY);
    expect(screen.queryByTestId("marketplace-source-remove")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });
});

describe("MarketplaceSourceRow: third-party (TC-001 S003, TC-004 S003)", () => {
  it("shows the raw catalog URL verbatim", () => {
    renderRow(ACME);
    expect(screen.getByTestId("marketplace-source-url")).toHaveTextContent(
      "https://marketplace.acme.example/catalog.json",
    );
  });

  it("carries an 'Unverified source' provenance marker", () => {
    renderRow(ACME);
    const pill = screen.getByTestId("marketplace-source-pill");
    expect(pill).toHaveTextContent("Unverified source");
    expect(pill.getAttribute("data-verified")).toBe("false");
  });

  it("exposes a Remove… control that fires onRemove with the source", async () => {
    const user = userEvent.setup();
    const { onRemove } = renderRow(ACME);
    const remove = screen.getByRole("button", { name: "Remove marketplace.acme.example…" });
    expect(remove).toHaveTextContent("Remove…");
    await user.click(remove);
    expect(onRemove).toHaveBeenCalledWith(ACME);
  });

  it("reports the registration day and whether a credential is attached", () => {
    renderRow(ACME);
    expect(screen.getByTestId("marketplace-source-meta")).toHaveTextContent(
      "Registered 2026-07-15 · credential attached",
    );
  });

  it("reports 'no credential' when none is attached", () => {
    renderRow({ ...ACME, hasCredential: false });
    expect(screen.getByTestId("marketplace-source-meta")).toHaveTextContent(
      "Registered 2026-07-15 · no credential",
    );
  });
});
