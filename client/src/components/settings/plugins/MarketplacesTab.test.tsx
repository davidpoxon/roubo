// @vitest-environment jsdom
//
// CPHMTP-FR-001 / CPHMTP-US-001, verified by CPHMTP-TC-001 and CPHMTP-TC-004
// (issue #561): the Marketplaces settings section lists the built-in first-party
// source alongside every registered third-party source, and offers add and
// per-row remove entry points.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary } from "@roubo/shared";

vi.mock("../../../hooks/useMarketplaceSources");

import { useMarketplaceSources as _useSources } from "../../../hooks/useMarketplaceSources";
import MarketplacesTab from "./MarketplacesTab";

const mockedSources = vi.mocked(_useSources);

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

function setSources(sources: MarketplaceSourceSummary[]) {
  mockedSources.mockReturnValue({
    data: { sources },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useSources>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setSources([FIRST_PARTY, ACME]);
});

describe("MarketplacesTab (TC-001, TC-004)", () => {
  it("renders the 'Marketplaces' heading and a 'Registered marketplaces' list", () => {
    render(<MarketplacesTab />);
    expect(screen.getByRole("heading", { name: "Marketplaces" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Registered marketplaces" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Registered marketplaces" })).toBeInTheDocument();
  });

  it("lists the first-party row and every registered third-party row", () => {
    render(<MarketplacesTab />);
    const rows = screen.getAllByTestId("marketplace-source-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute("data-source-id")).toBe(FIRST_PARTY_SOURCE_ID);
    expect(rows[1].getAttribute("data-source-id")).toBe(ACME.id);
  });

  it("gives the first-party row no Remove control and the third-party row one", () => {
    render(<MarketplacesTab />);
    const [firstParty, thirdParty] = screen.getAllByTestId("marketplace-source-row");

    expect(within(firstParty).queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
    expect(within(firstParty).getByTestId("marketplace-source-pill")).toHaveTextContent(
      "Verified, first-party",
    );

    expect(within(thirdParty).getByRole("button", { name: /remove/i })).toBeInTheDocument();
    expect(within(thirdParty).getByTestId("marketplace-source-pill")).toHaveTextContent(
      "Unverified source",
    );
    expect(within(thirdParty).getByTestId("marketplace-source-url")).toHaveTextContent(ACME.url);
  });

  it("offers an 'Add marketplace…' entry point that fires onAddSource", async () => {
    const user = userEvent.setup();
    const onAddSource = vi.fn();
    render(<MarketplacesTab onAddSource={onAddSource} />);

    const add = screen.getByRole("button", { name: "Add marketplace…" });
    await user.click(add);
    expect(onAddSource).toHaveBeenCalledTimes(1);
  });

  it("fires onRemoveSource with the row's source when Remove… is pressed", async () => {
    const user = userEvent.setup();
    const onRemoveSource = vi.fn();
    render(<MarketplacesTab onRemoveSource={onRemoveSource} />);

    await user.click(screen.getByRole("button", { name: "Remove marketplace.acme.example…" }));
    expect(onRemoveSource).toHaveBeenCalledWith(ACME);
  });

  it("stays operable when no dialog callbacks are wired (the seams are optional)", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTab />);

    await user.click(screen.getByRole("button", { name: "Add marketplace…" }));
    await user.click(screen.getByRole("button", { name: "Remove marketplace.acme.example…" }));
    expect(screen.getAllByTestId("marketplace-source-row")).toHaveLength(2);
  });

  it("shows a loader while the source list is in flight", () => {
    mockedSources.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof _useSources>);

    render(<MarketplacesTab />);
    expect(screen.getByText("Loading marketplaces...")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Registered marketplaces" })).not.toBeInTheDocument();
  });

  it("surfaces a fetch error", () => {
    mockedSources.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("offline"),
    } as unknown as ReturnType<typeof _useSources>);

    render(<MarketplacesTab />);
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load marketplaces: offline");
  });

  it("shows an empty-state message when the list is empty", () => {
    setSources([]);
    render(<MarketplacesTab />);
    expect(screen.getByText("No marketplaces registered.")).toBeInTheDocument();
    expect(screen.queryByTestId("marketplace-source-row")).not.toBeInTheDocument();
  });
});
