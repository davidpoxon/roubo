// @vitest-environment jsdom
//
// Container wiring for source removal (CPHMTP-FR-009 / CPHMTP-US-006, issue #564).
// MarketplacesTab exposes the per-row Remove seam (issue #561); this container
// wires it to the removal consequences dialog and drives DELETE
// /api/marketplace/sources/:id on confirm. These cover that Remove… opens the
// dialog (CPHMTP-TC-011 S002, CPHMTP-TC-012), that confirming calls the mutation
// with the source id and reports the client-derived orphaned count
// (CPHMTP-TC-011 S004), that Cancel mutates nothing (CPHMTP-TC-021), and that a
// failure surfaces inline.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary, PluginRecord } from "@roubo/shared";
import { ApiError } from "../../../lib/api";

vi.mock("../../../hooks/useMarketplaceSources");
vi.mock("../../../hooks/usePlugins");
vi.mock("../../../hooks/useToast");

import {
  useMarketplaceSources as _useSources,
  useRemoveMarketplaceSource as _useRemove,
} from "../../../hooks/useMarketplaceSources";
import { usePlugins as _usePlugins } from "../../../hooks/usePlugins";
import { useToast as _useToast } from "../../../hooks/useToast";
import MarketplacesTabPanel from "./MarketplacesTabPanel";

const mockedSources = vi.mocked(_useSources);
const mockedRemove = vi.mocked(_useRemove);
const mockedPlugins = vi.mocked(_usePlugins);
const mockedToast = vi.mocked(_useToast);

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

const removeMutateAsync = vi.fn();
const addToast = vi.fn();

function setSources(sources: MarketplaceSourceSummary[]) {
  mockedSources.mockReturnValue({
    data: { sources },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useSources>);
}

function setPlugins(sourceIds: (string | undefined)[]) {
  const plugins = sourceIds.map((sourceId, i) => ({
    id: `plugin-${i}`,
    sourceId,
  })) as unknown as PluginRecord[];
  mockedPlugins.mockReturnValue({
    data: { hostApiVersion: "1.0.0", plugins },
  } as unknown as ReturnType<typeof _usePlugins>);
}

function setRemove(isPending = false) {
  mockedRemove.mockReturnValue({
    mutateAsync: removeMutateAsync,
    isPending,
  } as unknown as ReturnType<typeof _useRemove>);
}

beforeEach(() => {
  vi.clearAllMocks();
  removeMutateAsync.mockResolvedValue(undefined);
  setSources([FIRST_PARTY, ACME]);
  setPlugins([ACME.id]); // one installed plugin from ACME
  setRemove();
  mockedToast.mockReturnValue({ addToast, removeToast: vi.fn() });
});

function openRemoveDialog() {
  return userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Remove marketplace.acme.example…" }));
}

describe("MarketplacesTabPanel: opening the dialog (CPHMTP-TC-011, CPHMTP-TC-012)", () => {
  it("opens the consequences dialog when a row's Remove… is pressed", async () => {
    render(<MarketplacesTabPanel />);
    expect(screen.queryByTestId("marketplace-source-remove-dialog")).not.toBeInTheDocument();

    await openRemoveDialog();

    const dialog = screen.getByTestId("marketplace-source-remove-dialog");
    expect(
      within(dialog).getByRole("heading", { name: 'Remove "marketplace.acme.example"?' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-source-remove-url")).toHaveTextContent(ACME.url);
    expect(screen.getByTestId("marketplace-source-remove-keep")).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-source-remove-orphan")).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-source-remove-delete")).toBeInTheDocument();
  });
});

describe("MarketplacesTabPanel: confirming removal (CPHMTP-TC-011 S004)", () => {
  it("calls removeMarketplaceSource with the source id and reports the orphaned count", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-confirm"));

    await waitFor(() => expect(removeMutateAsync).toHaveBeenCalledWith(ACME.id));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Removed marketplace.acme.example; 1 plugin orphaned"),
    );
    // The dialog closes once removal succeeds.
    await waitFor(() =>
      expect(screen.queryByTestId("marketplace-source-remove-dialog")).not.toBeInTheDocument(),
    );
  });

  it("pluralises the orphaned count for more than one affected plugin", async () => {
    setPlugins([ACME.id, ACME.id, "other-source"]); // two from ACME, one elsewhere
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-confirm"));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Removed marketplace.acme.example; 2 plugins orphaned"),
    );
  });

  it("reports zero orphaned when the source has no installed plugins", async () => {
    setPlugins(["other-source"]);
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-confirm"));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Removed marketplace.acme.example; 0 plugins orphaned"),
    );
  });
});

describe("MarketplacesTabPanel: cancelling (CPHMTP-TC-021)", () => {
  it("closes the dialog and mutates nothing when Cancel is pressed", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("marketplace-source-remove-dialog")).not.toBeInTheDocument(),
    );
    expect(removeMutateAsync).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});

describe("MarketplacesTabPanel: failure", () => {
  it("surfaces a removal failure inline and keeps the dialog open", async () => {
    removeMutateAsync.mockRejectedValueOnce(new ApiError("Keyring is locked", 500));
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("marketplace-source-remove-error")).toHaveTextContent(
        "Keyring is locked",
      ),
    );
    expect(screen.getByTestId("marketplace-source-remove-dialog")).toBeInTheDocument();
    expect(addToast).not.toHaveBeenCalled();
  });
});
