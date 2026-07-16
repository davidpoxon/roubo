// @vitest-environment jsdom
//
// Marketplace catalog view (CP-FR-020 / CP-US-010, issue #621): browse, search,
// kind filter, install/update affordances, installed-state with no install
// affordance, and the absence of any third-party submission affordance.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type {
  InstallPreview,
  MarketplaceCatalogSource,
  MarketplaceListing,
  MarketplaceSourceStatus,
  PluginPermissions,
} from "@roubo/shared";
import { ApiError } from "../../lib/api";

vi.mock("../../hooks/useMarketplace");
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));
// Issue #399: Marketplace mints a ConsentRecord after a successful commit via
// useGrantConsent. Mock the hook so these tests need no QueryClientProvider and
// can assert the consent mutation payload.
const pluginHooks = vi.hoisted(() => ({ grantConsentMutate: vi.fn() }));
vi.mock("../../hooks/usePlugins", () => ({
  useGrantConsent: () => ({ mutate: pluginHooks.grantConsentMutate, isPending: false }),
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
    declaredPermissions: null,
    lifecycle: null,
    sourceId: FIRST_PARTY_SOURCE_ID,
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

// The always-present built-in source's status row (issue #557). The fan-out
// reports it first and it is never unavailable, so a first-party-only catalog
// renders no source filter chips (there is nothing to choose between).
const FIRST_PARTY_STATUS: MarketplaceSourceStatus = {
  id: FIRST_PARTY_SOURCE_ID,
  url: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
  label: "Roubo first-party",
  source: "network",
  fetchedAt: null,
  unavailable: false,
};

const ACME_SOURCE_ID = "marketplace-acme-example-1a2b3c4d";

function sourceStatus(over: Partial<MarketplaceSourceStatus> = {}): MarketplaceSourceStatus {
  return {
    id: ACME_SOURCE_ID,
    url: "https://marketplace.acme.example/catalog.json",
    label: "ACME workplace",
    source: "network",
    fetchedAt: "2026-07-02T00:00:00.000Z",
    unavailable: false,
    ...over,
  };
}

function setCatalog(
  listings: MarketplaceListing[],
  source: MarketplaceCatalogSource = "network",
  fetchedAt: string | null = null,
  sources: MarketplaceSourceStatus[] = [FIRST_PARTY_STATUS],
) {
  mockedCatalog.mockReturnValue({
    data: { curated: true, listings, source, fetchedAt, sources },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useCatalog>);
}

// An ISO timestamp two hours in the past, so the banner's relative formatter
// renders "fetched 2h ago" (CPHM-TC-043 S002-O02).
function twoHoursAgo(): string {
  return new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
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

  // Lifecycle + Declared permissions in the detail drawer (issue #401,
  // CP-TC-080 / CP-TC-097 / CP-TC-104). The server derives these onto the listing
  // pre-install; the drawer renders a Lifecycle row and a Declared permissions
  // section from them.
  describe("lifecycle and declared permissions (CP-TC-080 / CP-TC-097 / CP-TC-104)", () => {
    // A component plugin declaring network + credentials + docker (and nothing
    // else): declaredCategories() lists exactly those three.
    const RICH_PERMISSIONS: PluginPermissions = {
      network: { hosts: ["api.github.com"] },
      credentials: { slots: [{ slot: "github-token", scope: "read", description: "API token" }] },
      filesystem: { paths: [] },
      processes: false,
      ports: false,
      docker: {},
    };

    async function openDrawer(over: Partial<MarketplaceListing>) {
      setCatalog([listing(over)]);
      const user = userEvent.setup();
      render(<Marketplace />);
      await user.click(screen.getByTestId("marketplace-card-detail"));
      await waitFor(() => {
        expect(screen.getByTestId("marketplace-drawer")).toBeInTheDocument();
      });
    }

    // CP-TC-104 S001-O06: a long-running component shows a Lifecycle row naming
    // the supervised start / stop / health / logs shape.
    it("renders a long-running Lifecycle row for a long-running component", async () => {
      await openDrawer({ lifecycle: "long-running" });
      const row = screen.getByTestId("marketplace-drawer-lifecycle");
      expect(row).toHaveTextContent("long-running (start, stop, health, and logs)");
    });

    // CP-TC-097 S001-O01/O02: a one-shot component shows the one-shot rendering
    // and NO long-running (start / stop / health / logs) description.
    it("renders the one-shot Lifecycle rendering and no long-running description", async () => {
      await openDrawer({ lifecycle: "one-shot" });
      const row = screen.getByTestId("marketplace-drawer-lifecycle");
      expect(row).toHaveTextContent("one-shot (start runs to completion, then completed)");
      expect(row).not.toHaveTextContent("start, stop, health, and logs");
    });

    // Integration plugins carry no lifecycle: the row is omitted (lifecycle null).
    it("omits the Lifecycle row when the listing has no lifecycle", async () => {
      await openDrawer({ lifecycle: null });
      expect(screen.queryByTestId("marketplace-drawer-lifecycle")).not.toBeInTheDocument();
    });

    // CP-TC-080 S003-O01 / CP-TC-104 S001-O07: each declared category is listed
    // with its label and a plain-language description.
    it("lists each declared permission category with label and detail text", async () => {
      await openDrawer({ declaredPermissions: RICH_PERMISSIONS });
      const section = screen.getByTestId("marketplace-drawer-permissions");
      expect(within(section).getByText("Network access")).toBeInTheDocument();
      expect(
        within(section).getByText("Reach external hosts: api.github.com."),
      ).toBeInTheDocument();
      expect(within(section).getByText("Stored credentials")).toBeInTheDocument();
      expect(
        within(section).getByText("Access stored credentials: github-token."),
      ).toBeInTheDocument();
      expect(within(section).getByText("Docker")).toBeInTheDocument();
    });

    // CP-TC-080 S003-O02: no undeclared category appears. RICH_PERMISSIONS does
    // not declare filesystem / processes / ports, so none of their labels render.
    it("renders no undeclared permission category", async () => {
      await openDrawer({ declaredPermissions: RICH_PERMISSIONS });
      const section = screen.getByTestId("marketplace-drawer-permissions");
      expect(within(section).queryByText("Filesystem")).not.toBeInTheDocument();
      expect(within(section).queryByText("Run processes")).not.toBeInTheDocument();
      expect(within(section).queryByText("Network ports")).not.toBeInTheDocument();
    });

    // A plugin that declares no special permissions shows the empty-state copy.
    it("shows the no-permissions copy when nothing is declared", async () => {
      const emptyPermissions: PluginPermissions = {
        network: { hosts: [] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
        ports: false,
        docker: false,
      };
      await openDrawer({ declaredPermissions: emptyPermissions });
      const section = screen.getByTestId("marketplace-drawer-permissions");
      expect(section).toHaveTextContent("This plugin declares no special permissions.");
    });

    // When the manifest is unavailable pre-install (declaredPermissions null),
    // the section is omitted entirely rather than rendered empty.
    it("omits the Declared permissions section when declaredPermissions is null", async () => {
      await openDrawer({ declaredPermissions: null });
      expect(screen.queryByTestId("marketplace-drawer-permissions")).not.toBeInTheDocument();
    });
  });

  // CPHM-TC-043 (S001/S002) + CPHM-TC-051 (S003), issue #372: the offline /
  // staleness banner. It is absent on a live network catalog and present when the
  // catalog degraded to the last-known cache or the bundled seed, while the
  // (cached) entries still render.
  describe("offline / staleness banner (CPHM-TC-043 / CPHM-TC-051)", () => {
    it("does not render the banner when the catalog is live (source network)", () => {
      setCatalog(CATALOG, "network");
      render(<Marketplace />);
      expect(screen.queryByTestId("marketplace-offline-banner")).not.toBeInTheDocument();
      // It must NOT reuse the shared testbench staleness-banner testid.
      expect(screen.queryByTestId("staleness-banner")).not.toBeInTheDocument();
    });

    it("renders the cache banner with the staleness, and cached entries still render (S001/S002)", () => {
      setCatalog(CATALOG, "cache", twoHoursAgo());
      render(<Marketplace />);
      const banner = screen.getByTestId("marketplace-offline-banner");
      // (a) marketplace unreachable + last verified catalog shown (S002-O01).
      expect(banner).toHaveTextContent(/marketplace is unreachable/i);
      expect(banner).toHaveTextContent(/last verified catalog/i);
      // (b) staleness from fetchedAt: "fetched 2h ago" (S002-O02).
      expect(banner).toHaveTextContent(/fetched 2h ago/i);
      // (c) seeded/installed remain available, new installs paused (S002-O03).
      expect(banner).toHaveTextContent(/seeded and installed plugins remain available/i);
      expect(banner).toHaveTextContent(/new installs are paused/i);
      // The cached catalog entries still render (S001-O01/O02): the grid is shown.
      expect(screen.getByTestId("marketplace-grid")).toBeInTheDocument();
      expect(screen.getAllByTestId("marketplace-card")).toHaveLength(3);
    });

    it("renders the seed banner without a fetch timestamp (seed fetchedAt is null)", () => {
      setCatalog(CATALOG, "seed", null);
      render(<Marketplace />);
      const banner = screen.getByTestId("marketplace-offline-banner");
      expect(banner).toHaveTextContent(/marketplace is unreachable/i);
      expect(banner).toHaveTextContent(/last verified catalog/i);
      // Seed has no fetch timestamp, so no "fetched ... ago" clause.
      expect(banner).not.toHaveTextContent(/fetched/i);
      expect(banner).toHaveTextContent(/new installs are paused/i);
      // Seeded entries still render.
      expect(screen.getByTestId("marketplace-grid")).toBeInTheDocument();
    });
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

// The 4-step install progress surface (issue #374). The four stages already run
// across the two existing server calls (preview = download + verify catalog
// Issue #557 (CPHMTP-FR-004 / CPHMTP-TC-028 / CPHMTP-TC-029): the Browse screen
// renders the MERGED multi-source list. Every card carries exactly one source
// provenance chip, first-party rendered distinctly from a registered source, and
// the source filter chip row scopes the list to one source and back to all.
describe("Marketplace multi-source browse (issue #557)", () => {
  const MERGED: MarketplaceListing[] = [
    listing({ id: "redis", name: "Redis" }),
    listing({
      id: "ghe",
      name: "GitHub Enterprise",
      kind: "integration",
      summary: "Connect a self-hosted GitHub Enterprise instance.",
      verified: false,
      sourceId: ACME_SOURCE_ID,
    }),
  ];

  function setMerged(over: Partial<MarketplaceSourceStatus> = {}) {
    setCatalog(MERGED, "network", null, [FIRST_PARTY_STATUS, sourceStatus(over)]);
  }

  function cardFor(id: string): HTMLElement {
    const card = screen
      .getAllByTestId("marketplace-card")
      .find((c) => c.getAttribute("data-plugin-id") === id);
    if (!card) throw new Error(`expected a card for ${id}`);
    return card;
  }

  // CPHMTP-TC-028 S001: the list contains entries from the first-party catalog
  // and from every registered source.
  it("renders first-party and registered-source entries in one list", () => {
    setMerged();
    render(<Marketplace />);
    expect(screen.getAllByTestId("marketplace-card")).toHaveLength(2);
    expect(cardFor("redis")).toBeTruthy();
    expect(cardFor("ghe")).toBeTruthy();
  });

  // CPHMTP-TC-028 S002-O01: every entry carries exactly one visible provenance
  // chip naming its originating source.
  it("gives every entry exactly one provenance chip naming its source", () => {
    setMerged();
    render(<Marketplace />);
    for (const card of screen.getAllByTestId("marketplace-card")) {
      expect(within(card).getAllByTestId("marketplace-card-source")).toHaveLength(1);
    }
    expect(within(cardFor("redis")).getByTestId("marketplace-card-source")).toHaveTextContent(
      "Roubo first-party",
    );
    expect(within(cardFor("ghe")).getByTestId("marketplace-card-source")).toHaveTextContent(
      "ACME workplace",
    );
  });

  // CPHMTP-TC-028 S002-O02: first-party provenance is rendered DISTINCTLY from
  // third-party provenance (green versus amber), so an unsigned source cannot
  // visually pass itself off as the curated catalog.
  it("renders first-party provenance distinctly from a third-party source", () => {
    setMerged();
    render(<Marketplace />);
    const firstParty = within(cardFor("redis")).getByTestId("marketplace-card-source");
    const thirdParty = within(cardFor("ghe")).getByTestId("marketplace-card-source");
    expect(firstParty.getAttribute("data-source-id")).toBe(FIRST_PARTY_SOURCE_ID);
    expect(thirdParty.getAttribute("data-source-id")).toBe(ACME_SOURCE_ID);
    expect(firstParty.className).toContain("green");
    expect(thirdParty.className).toContain("amber");
    expect(firstParty.className).not.toContain("amber");
  });

  it("labels each provenance chip for a screen reader rather than showing a bare host", () => {
    setMerged();
    render(<Marketplace />);
    expect(screen.getByLabelText("Source: Roubo first-party")).toBeTruthy();
    expect(screen.getByLabelText("Source: ACME workplace")).toBeTruthy();
  });

  // CPHMTP-TC-029: the filter chips scope the list to a single source and back.
  // Filtering is server-side (the same seam as the kind chips), so what the chip
  // must do here is re-query with the chosen sourceId.
  it("scopes the list to a single source and back to all sources (CPHMTP-TC-029)", async () => {
    const user = userEvent.setup();
    setMerged();
    render(<Marketplace />);

    // S001: pick the first-party chip.
    await user.click(screen.getByTestId(`marketplace-source-filter-${FIRST_PARTY_SOURCE_ID}`));
    await waitFor(() =>
      expect(mockedCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourceId: FIRST_PARTY_SOURCE_ID }),
      ),
    );

    // S002: pick the ACME workplace chip.
    await user.click(screen.getByTestId(`marketplace-source-filter-${ACME_SOURCE_ID}`));
    await waitFor(() =>
      expect(mockedCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourceId: ACME_SOURCE_ID }),
      ),
    );

    // S003: back to all sources; the scoping is dropped entirely.
    await user.click(screen.getByTestId("marketplace-source-filter-__all__"));
    await waitFor(() =>
      expect(mockedCatalog).toHaveBeenLastCalledWith(
        expect.objectContaining({ sourceId: undefined }),
      ),
    );
  });

  it("renders one filter chip per source plus the all-sources default", () => {
    setMerged();
    render(<Marketplace />);
    // React Aria's Radio renders a visually-hidden input for the radio role and
    // labels it with the chip's own element, so read the chips themselves.
    const row = screen.getByTestId("marketplace-source-filter");
    const chips = [...row.children].map((c) => c.textContent);
    expect(chips).toEqual(["All sources", "Roubo first-party", "ACME workplace"]);
  });

  it("keeps the full chip row while the list is scoped to one source", async () => {
    const user = userEvent.setup();
    setMerged();
    render(<Marketplace />);
    await user.click(screen.getByTestId(`marketplace-source-filter-${ACME_SOURCE_ID}`));
    // Without the other chips there would be no way back to the merged list.
    expect(screen.getByTestId(`marketplace-source-filter-${FIRST_PARTY_SOURCE_ID}`)).toBeTruthy();
    expect(screen.getByTestId("marketplace-source-filter-__all__")).toBeTruthy();
  });

  it("hides the source filter entirely when only the built-in source exists", () => {
    // Nothing to filter between: the chip row would be a control with one choice.
    setCatalog(CATALOG);
    render(<Marketplace />);
    expect(screen.queryByTestId("marketplace-source-filter")).toBeNull();
  });

  // CPHMTP-TC-046 / CPHMTP-TC-036 S002-O01: only the failed source shows a
  // degraded state; the healthy sources' entries stay listed.
  it("calls out only the unavailable source while the rest list normally", () => {
    setMerged({ unavailable: true, source: "cache", fetchedAt: null });
    render(<Marketplace />);
    const notice = screen.getByTestId("marketplace-sources-unavailable");
    expect(notice).toHaveTextContent("ACME workplace is unavailable right now");
    expect(notice).toHaveTextContent("Every other source is unaffected");
    // First-party entries are unaffected, and the first-party offline banner
    // (a separate, first-party-scoped surface) stays away.
    expect(cardFor("redis")).toBeTruthy();
    expect(screen.queryByTestId("marketplace-offline-banner")).toBeNull();
  });

  it("shows no unavailable notice while every source is healthy", () => {
    setMerged();
    render(<Marketplace />);
    expect(screen.queryByTestId("marketplace-sources-unavailable")).toBeNull();
  });

  it("names every unavailable source when more than one is down", () => {
    setCatalog(MERGED, "network", null, [
      FIRST_PARTY_STATUS,
      sourceStatus({ unavailable: true, fetchedAt: null }),
      sourceStatus({
        id: "other",
        label: "other.example",
        unavailable: true,
        fetchedAt: null,
      }),
    ]);
    render(<Marketplace />);
    const notice = screen.getByTestId("marketplace-sources-unavailable");
    expect(notice).toHaveTextContent("ACME workplace, other.example are unavailable right now");
  });
});

// signature + verify artifact digest; confirm = unpack & install); this widget
// surfaces them, fail-closed, across both the staging phase (a dedicated
// progress modal) and the confirm phase (inside the consent modal).
describe("Marketplace 4-step install progress (CPHM-TC-017 / -018 / -019)", () => {
  function redisManifest() {
    return {
      id: "redis",
      name: "Redis",
      version: "1.3.0",
      description: "A Redis cache component.",
      kind: "component",
      roubo: ">=0.1.0",
      entry: "index.js",
      permissions: {
        network: { hosts: [] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
        ports: { names: ["redis"] },
        docker: {},
      },
    };
  }

  function previewFixture(): InstallPreview {
    return {
      stagingToken: "staging-1.3.0",
      manifest: redisManifest(),
      source: { type: "release", assetUrl: "https://example.com/d/redis-1.3.0.tgz" },
    } as unknown as InstallPreview;
  }

  function installSucceeds() {
    const mutate = vi.fn((_id: string, opts: { onSuccess: (p: InstallPreview) => void }) => {
      opts.onSuccess(previewFixture());
    });
    mockedInstallPreview.mockReturnValue(mutationStub({ mutate }));
    return mutate;
  }

  // CPHM-TC-017 S002-O01: clicking Install opens the Install & verify screen
  // showing all four stages, and the happy path completes through Unpack &
  // install (the confirm fires and the gate closes to the success toast).
  it("shows all four stages in the consent modal with stages 1-3 done and stage 4 pending", async () => {
    installSucceeds();
    setCatalog([CATALOG[0]]); // redis, not installed
    const user = userEvent.setup();
    render(<Marketplace />);

    await user.click(screen.getByTestId("marketplace-card-install"));

    const modal = await screen.findByTestId("marketplace-consent-modal");
    const widget = within(modal).getByTestId("marketplace-install-progress");
    expect(widget).toBeInTheDocument();
    // Stages 1-3 are done after staging; stage 4 awaits the gated confirm.
    expect(within(widget).getByTestId("marketplace-install-step-0")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(within(widget).getByTestId("marketplace-install-step-1")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(within(widget).getByTestId("marketplace-install-step-2")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(within(widget).getByTestId("marketplace-install-step-3")).toHaveAttribute(
      "data-status",
      "pending",
    );
  });

  it("completes the happy path through Unpack & install (confirm fires, the gate closes)", async () => {
    installSucceeds();
    const confirm = vi.fn((_token: string, opts: { onSuccess: () => void }) => opts.onSuccess());
    mockedConfirm.mockReturnValue(mutationStub({ mutate: confirm }));
    setCatalog([CATALOG[0]]);
    const user = userEvent.setup();
    render(<Marketplace />);

    await user.click(screen.getByTestId("marketplace-card-install"));
    await screen.findByTestId("marketplace-consent-modal");
    await user.click(within(screen.getByTestId("marketplace-consent-ack")).getByRole("checkbox"));
    await user.click(screen.getByTestId("marketplace-consent-confirm"));

    expect(confirm).toHaveBeenCalledWith("staging-1.3.0", expect.anything());
    // Issue #399 (CP-TC-090): the successful commit mints a ConsentRecord with
    // the acknowledged (all declared) categories for the installed plugin.
    expect(pluginHooks.grantConsentMutate).toHaveBeenCalledWith({
      pluginId: "redis",
      acknowledgedCategories: ["ports", "docker"],
    });
    await waitFor(() => {
      expect(screen.queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
    });
  });

  it("advances stage 4 to active while the confirm mutation is in flight", async () => {
    installSucceeds();
    mockedConfirm.mockReturnValue(mutationStub({ isPending: true }));
    setCatalog([CATALOG[0]]);
    const user = userEvent.setup();
    render(<Marketplace />);

    await user.click(screen.getByTestId("marketplace-card-install"));
    const modal = await screen.findByTestId("marketplace-consent-modal");
    expect(within(modal).getByTestId("marketplace-install-step-3")).toHaveAttribute(
      "data-status",
      "active",
    );
  });

  // A confirm-phase failure lands fail-closed on stage 4 inside the consent modal.
  it("fails stage 4 on a confirm-phase error", async () => {
    installSucceeds();
    const confirm = vi.fn((_token: string, opts: { onError: (e: unknown) => void }) =>
      opts.onError(new ApiError("commit failed", 500, "internal")),
    );
    mockedConfirm.mockReturnValue(mutationStub({ mutate: confirm }));
    setCatalog([CATALOG[0]]);
    const user = userEvent.setup();
    render(<Marketplace />);

    await user.click(screen.getByTestId("marketplace-card-install"));
    await screen.findByTestId("marketplace-consent-modal");
    await user.click(within(screen.getByTestId("marketplace-consent-ack")).getByRole("checkbox"));
    await user.click(screen.getByTestId("marketplace-consent-confirm"));

    const modal = screen.getByTestId("marketplace-consent-modal");
    await waitFor(() => {
      expect(within(modal).getByTestId("marketplace-install-step-3")).toHaveAttribute(
        "data-status",
        "failed",
      );
    });
    // Issue #399: a failed commit mints no consent (the plugin never installed).
    expect(pluginHooks.grantConsentMutate).not.toHaveBeenCalled();
  });

  // CPHM-TC-018: a digest mismatch during staging marks the Verify artifact
  // digest stage failed (fail-closed) and nothing is installed: stage 4 stays
  // pending, no consent modal opens, the card remains uninstalled.
  it("marks the digest stage failed fail-closed on a staging integrity failure (CPHM-TC-018)", async () => {
    const mutate = vi.fn((_id: string, opts: { onError: (e: unknown) => void }) => {
      opts.onError(new ApiError("integrity verification failure", 422, "integrity-failed"));
    });
    mockedInstallPreview.mockReturnValue(mutationStub({ mutate }));
    setCatalog([CATALOG[0]]);
    const user = userEvent.setup();
    render(<Marketplace />);

    await user.click(screen.getByTestId("marketplace-card-install"));

    const progressModal = await screen.findByTestId("marketplace-install-progress-modal");
    const widget = within(progressModal).getByTestId("marketplace-install-progress");
    const digestStep = within(widget).getByTestId("marketplace-install-step-2");
    expect(digestStep).toHaveAttribute("data-status", "failed");
    expect(within(digestStep).getByTestId("marketplace-install-step-2-error")).toHaveTextContent(
      /nothing written, nothing executed/i,
    );
    // Nothing is installed: the Unpack & install stage never starts.
    expect(within(widget).getByTestId("marketplace-install-step-3")).toHaveAttribute(
      "data-status",
      "pending",
    );
    // No consent modal opens (staging failed) and the card stays uninstalled.
    expect(screen.queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
    expect(screen.getByTestId("marketplace-card-install")).toBeInTheDocument();

    // The failure surface is dismissable.
    await user.click(screen.getByTestId("marketplace-install-progress-close"));
    await waitFor(() => {
      expect(screen.queryByTestId("marketplace-install-progress-modal")).not.toBeInTheDocument();
    });
  });

  // CPHM-TC-019: a bad catalog signature surfaced during install marks the
  // Verify catalog signature stage failed and refuses the install (fail-closed),
  // with no later stage starting.
  it("marks the catalog-signature stage failed when the catalog is unverified at install (CPHM-TC-019)", async () => {
    const mutate = vi.fn((_id: string, opts: { onError: (e: unknown) => void }) => {
      opts.onError(new ApiError("catalog could not be verified", 502, "catalog-unverified"));
    });
    mockedInstallPreview.mockReturnValue(mutationStub({ mutate }));
    setCatalog([CATALOG[0]]);
    const user = userEvent.setup();
    render(<Marketplace />);

    await user.click(screen.getByTestId("marketplace-card-install"));

    const widget = within(
      await screen.findByTestId("marketplace-install-progress-modal"),
    ).getByTestId("marketplace-install-progress");
    expect(within(widget).getByTestId("marketplace-install-step-1")).toHaveAttribute(
      "data-status",
      "failed",
    );
    // The digest and unpack stages never start (install refused before download finished).
    expect(within(widget).getByTestId("marketplace-install-step-2")).toHaveAttribute(
      "data-status",
      "pending",
    );
    expect(within(widget).getByTestId("marketplace-install-step-3")).toHaveAttribute(
      "data-status",
      "pending",
    );
    expect(screen.queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
  });

  // The update path surfaces the same progress surface, titled for an update.
  it("surfaces an update staging failure on the matching stage, titled for the update", async () => {
    const mutate = vi.fn((_id: string, opts: { onError: (e: unknown) => void }) => {
      opts.onError(new ApiError("integrity verification failure", 422, "integrity-failed"));
    });
    mockedUpdatePreview.mockReturnValue(mutationStub({ mutate }));
    setCatalog([CATALOG[2]]); // worker-queue, update available
    const user = userEvent.setup();
    render(<Marketplace />);

    await user.click(screen.getByTestId("marketplace-card-update"));

    const progressModal = await screen.findByTestId("marketplace-install-progress-modal");
    expect(progressModal).toHaveTextContent(/Updating Worker Queue/i);
    expect(within(progressModal).getByTestId("marketplace-install-step-2")).toHaveAttribute(
      "data-status",
      "failed",
    );
  });
});
