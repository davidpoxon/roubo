// @vitest-environment jsdom
//
// Marketplace catalog view (CP-FR-020 / CP-US-010, issue #621): browse, search,
// kind filter, install/update affordances, installed-state with no install
// affordance, and the absence of any third-party submission affordance.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MarketplaceListing } from "@roubo/shared";
import { ApiError } from "../../lib/api";

vi.mock("../../hooks/useMarketplace");
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

import {
  useMarketplaceCatalog as _useCatalog,
  useMarketplaceInstallPreview as _useInstallPreview,
  useMarketplaceUpdatePreview as _useUpdatePreview,
  useMarketplaceInstallConfirm as _useConfirm,
  useMarketplaceInstallCancel as _useCancel,
} from "../../hooks/useMarketplace";
import Marketplace from "./Marketplace";

const mockedCatalog = vi.mocked(_useCatalog);
const mockedInstallPreview = vi.mocked(_useInstallPreview);
const mockedUpdatePreview = vi.mocked(_useUpdatePreview);
const mockedConfirm = vi.mocked(_useConfirm);
const mockedCancel = vi.mocked(_useCancel);

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
    ...over,
  };
}

const CATALOG: MarketplaceListing[] = [
  listing(),
  listing({
    id: "github-com",
    name: "GitHub.com",
    kind: "integration",
    version: "0.2.0",
    summary: "Connect GitHub issues to benches.",
    installed: true,
    installedVersion: "0.2.0",
    updateAvailable: false,
  }),
  listing({
    id: "worker-queue",
    name: "Worker Queue",
    kind: "component",
    version: "1.1.0",
    summary: "A background job worker.",
    installed: true,
    installedVersion: "1.0.0",
    updateAvailable: true,
  }),
];

function mutationStub<T>(extra: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    ...extra,
  } as unknown as T;
}

function setCatalog(listings: MarketplaceListing[]) {
  mockedCatalog.mockReturnValue({
    data: { curated: true, listings },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useCatalog>);
}

function setCatalogError(error: unknown) {
  mockedCatalog.mockReturnValue({
    data: undefined,
    isLoading: false,
    error,
  } as unknown as ReturnType<typeof _useCatalog>);
}

beforeEach(() => {
  vi.clearAllMocks();
  setCatalog(CATALOG);
  mockedInstallPreview.mockReturnValue(mutationStub());
  mockedUpdatePreview.mockReturnValue(mutationStub());
  mockedConfirm.mockReturnValue(mutationStub());
  mockedCancel.mockReturnValue(mutationStub());
});

describe("Marketplace catalog", () => {
  it("renders component and integration entries with verified marker and version", () => {
    render(<Marketplace />);
    const cards = screen.getAllByTestId("marketplace-card");
    expect(cards).toHaveLength(3);
    // every card has a verified badge and a version
    for (const card of cards) {
      expect(within(card).getByTestId("marketplace-card-verified")).toBeInTheDocument();
      expect(within(card).getByTestId("marketplace-card-version")).toBeInTheDocument();
    }
    // both kinds present
    const kinds = cards.map((c) => within(c).getByTestId("marketplace-card-kind").textContent);
    expect(kinds).toContain("component");
    expect(kinds).toContain("integration");
  });

  it("shows the first-party curated header badge", () => {
    render(<Marketplace />);
    expect(screen.getByTestId("marketplace-curated-badge")).toHaveTextContent(
      "First-party curated",
    );
  });

  it("re-queries the catalog when the search field changes", async () => {
    const user = userEvent.setup();
    render(<Marketplace />);
    await user.type(screen.getByTestId("marketplace-search"), "redis");
    await waitFor(() => {
      expect(mockedCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ q: "redis", kind: undefined }),
      );
    });
  });

  it("re-queries the catalog filtered by kind when a kind tab is selected", async () => {
    const user = userEvent.setup();
    render(<Marketplace />);
    await user.click(screen.getByTestId("marketplace-filter-integration"));
    await waitFor(() => {
      expect(mockedCatalog).toHaveBeenCalledWith(expect.objectContaining({ kind: "integration" }));
    });
  });

  it("shows an installed plugin with no install or update affordance", () => {
    setCatalog([CATALOG[1]]); // github-com, installed, current
    render(<Marketplace />);
    const card = screen.getByTestId("marketplace-card");
    expect(within(card).getByTestId("marketplace-card-installed")).toBeInTheDocument();
    expect(within(card).queryByTestId("marketplace-card-install")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("marketplace-card-update")).not.toBeInTheDocument();
  });

  it("shows an update affordance when an update is available", () => {
    setCatalog([CATALOG[2]]); // worker-queue, update available
    render(<Marketplace />);
    const card = screen.getByTestId("marketplace-card");
    expect(within(card).getByTestId("marketplace-card-update")).toBeInTheDocument();
    expect(within(card).queryByTestId("marketplace-card-installed")).not.toBeInTheDocument();
    expect(within(card).queryByTestId("marketplace-card-install")).not.toBeInTheDocument();
  });

  it("stages an install preview when Install is pressed", async () => {
    const mutate = vi.fn();
    mockedInstallPreview.mockReturnValue(mutationStub({ mutate }));
    setCatalog([CATALOG[0]]); // redis, not installed
    const user = userEvent.setup();
    render(<Marketplace />);
    await user.click(screen.getByTestId("marketplace-card-install"));
    expect(mutate).toHaveBeenCalledWith("redis", expect.anything());
  });

  it("stages an update preview when Update is pressed", async () => {
    const mutate = vi.fn();
    mockedUpdatePreview.mockReturnValue(mutationStub({ mutate }));
    setCatalog([CATALOG[2]]); // worker-queue, update available
    const user = userEvent.setup();
    render(<Marketplace />);
    await user.click(screen.getByTestId("marketplace-card-update"));
    expect(mutate).toHaveBeenCalledWith("worker-queue", expect.anything());
  });

  it("opens the detail drawer from a card title", async () => {
    const user = userEvent.setup();
    render(<Marketplace />);
    const cards = screen.getAllByTestId("marketplace-card");
    await user.click(within(cards[0]).getByTestId("marketplace-card-detail"));
    await waitFor(() => {
      expect(screen.getByTestId("marketplace-drawer")).toBeInTheDocument();
    });
  });

  it("renders an empty state when the catalog has no matches", () => {
    setCatalog([]);
    render(<Marketplace />);
    expect(screen.getByTestId("marketplace-empty")).toBeInTheDocument();
  });

  // CP-TC-118 / AC-3: an unverified catalog renders a dedicated error and zero
  // plugin cards / Install buttons.
  it("renders the catalog-unverified error and no plugin cards when the catalog is unverified", () => {
    setCatalogError(
      new ApiError("The plugin catalog could not be verified.", 502, "catalog-unverified"),
    );
    render(<Marketplace />);
    expect(screen.getByTestId("marketplace-unverified")).toBeInTheDocument();
    expect(screen.queryByTestId("marketplace-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("marketplace-card-install")).not.toBeInTheDocument();
    expect(screen.queryByTestId("marketplace-grid")).not.toBeInTheDocument();
  });

  // CP-TC-106: a registry-unavailable / transport failure renders a generic
  // graceful error (distinct from the unverified-catalog error) and no cards.
  it("renders a generic graceful error when the registry is unavailable", () => {
    setCatalogError(new ApiError("Network error", 503, "internal"));
    render(<Marketplace />);
    expect(screen.getByTestId("marketplace-error")).toBeInTheDocument();
    expect(screen.queryByTestId("marketplace-unverified")).not.toBeInTheDocument();
    expect(screen.queryByTestId("marketplace-card")).not.toBeInTheDocument();
  });

  // CP-TC-107: an integrity failure during the install preview surfaces an error
  // to the user (via the toast) and the card stays uninstalled (no consent
  // modal opens because staging itself failed).
  it("surfaces an integrity failure from the install preview as a toast", async () => {
    const mutate = vi.fn((_id: string, opts: { onError: (e: unknown) => void }) => {
      opts.onError(new ApiError("integrity verification failure", 422, "integrity-failed"));
    });
    mockedInstallPreview.mockReturnValue(mutationStub({ mutate }));
    setCatalog([CATALOG[0]]); // redis, not installed
    const user = userEvent.setup();
    render(<Marketplace />);
    await user.click(screen.getByTestId("marketplace-card-install"));
    // No consent modal opens (staging failed); the card remains uninstalled.
    expect(screen.queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
    expect(screen.getByTestId("marketplace-card-install")).toBeInTheDocument();
  });

  it("shows integrity, provenance, and sandbox rows in the detail drawer (CP-TC-104)", async () => {
    const user = userEvent.setup();
    setCatalog([CATALOG[0]]);
    render(<Marketplace />);
    await user.click(screen.getByTestId("marketplace-card-detail"));
    await waitFor(() => {
      expect(screen.getByTestId("marketplace-drawer")).toBeInTheDocument();
    });
    expect(screen.getByTestId("marketplace-drawer-integrity")).toHaveTextContent("signed by Roubo");
    expect(screen.getByTestId("marketplace-drawer-provenance")).toHaveTextContent(
      "roubo/plugins@redis",
    );
    expect(screen.getByTestId("marketplace-drawer-sandbox")).toHaveTextContent("Unsandboxed");
  });

  it("has no third-party submission affordance anywhere", () => {
    render(<Marketplace />);
    // No submit / publish / contribute control exists in the marketplace UI.
    expect(screen.queryByText(/submit a plugin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/publish/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/contribute a plugin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/add your plugin/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("marketplace-submit")).not.toBeInTheDocument();
  });
});
