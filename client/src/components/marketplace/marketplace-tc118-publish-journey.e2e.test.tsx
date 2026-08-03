// @vitest-environment jsdom
//
// AP-TC-118 S005/S006 (issue #533, AP-WU-032), the RENDERED half: a user who has
// never seen a newly published third-party agent plugin opens the Marketplace,
// finds it as an agent-kind listing carrying its compatibility metadata, and
// installs it through the Install button.
//
// The server-side half of the same journey (S001-S006: the published SDK surface,
// the authored manifest, the packaged digest, the catalog acceptance, and the real
// install -> integrity verify -> commit) is guarded in
// server/services/marketplace-third-party-publish-tc118-journey.e2e.test.ts. This
// file exists because S005 and S006's Install button name a RENDERED surface, and
// a projection the card never renders is not a journey a user can walk.
//
// Hermetic by construction, matching the marketplace-tc047-trust-journey.e2e.test.tsx
// precedent: a real QueryClientProvider, the REAL Marketplace / MarketplaceCard /
// MarketplaceConsentModal / ProvenanceBadge components and the REAL useMarketplace
// React Query hooks (catalog query, install-preview mutation, and the confirm
// mutation with its real cache-invalidation seam), with only the `../../lib/api`
// boundary mocked. useToast is mocked so addToast can be captured and no console
// noise escapes.
//
// ── Reconciliation of S005-O02 ──
//
// "Its declared compatibility metadata is displayed on the listing" is not
// satisfiable as shipped for a GENUINELY PUBLISHED plugin. The server derives
// `agentCompatibility` from the entry's declared manifest, and that manifest is
// only in reach for an installed record or a `git` source with a local directory;
// a published third-party plugin is a `source.type: "release"` entry that is not
// installed yet, and `MarketplaceCatalogEntry` carries no compatibility field. So
// the projection is null and the card renders its "compatibility not declared"
// fallback (AP-TC-121). Both halves of the CARD's behaviour are asserted below:
// it renders the declared floor and ceiling the moment the projection supplies
// them, and it renders the fallback when the projection is null. Both fixtures
// are hand-built listings, so neither exercises the server projection and neither
// changes when the gap closes. The assertion that genuinely pins the shipped
// release-entry projection (and that will fail when the gap closes) is the server
// half, server/services/marketplace-third-party-publish-tc118-journey.e2e.test.ts
// ("S005-O02 (reconciled)"), which drives the real `listCatalog()`. Closing the
// gap means widening the catalog entry, which is product work owned by #522 and
// filed as davidpoxon/roubo-development#722.
//
// Failure-output contract (AP-FR-020): every assertion carries an
// expected-vs-actual message naming the diverged step (and its observation id)
// plus the owning slice issue from this unit's blocked_by/covers set.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type {
  InstallPreview,
  MarketplaceListing,
  MarketplaceSourceStatus,
  PluginManifest,
} from "@roubo/shared";
import Marketplace from "./Marketplace";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchMarketplaceCatalog: vi.fn(),
    installFromMarketplace: vi.fn(),
    updateFromMarketplace: vi.fn(),
    confirmInstallPlugin: vi.fn(),
    cancelInstallPlugin: vi.fn(),
    grantPluginConsent: vi.fn(),
  };
});

const addToast = vi.fn();
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ addToast }),
}));

import {
  fetchMarketplaceCatalog,
  installFromMarketplace,
  updateFromMarketplace,
  confirmInstallPlugin,
  cancelInstallPlugin,
  grantPluginConsent,
} from "../../lib/api";

const mockedFetch = vi.mocked(fetchMarketplaceCatalog);
const mockedInstall = vi.mocked(installFromMarketplace);
const mockedUpdate = vi.mocked(updateFromMarketplace);
const mockedConfirm = vi.mocked(confirmInstallPlugin);
const mockedCancel = vi.mocked(cancelInstallPlugin);
const mockedGrantConsent = vi.mocked(grantPluginConsent);

// ── Owning slices (AP-FR-020) ──
//
// From this unit's blocked_by/covers set in .specifications/agent-plugins/
// issues.json: [#519, #521, #522, #523, #537].
const SLICE_MARKETPLACE = "#522 (marketplace distribution for agent-kind plugins)";
const SLICE_COMPAT = "#519 (version gating, compatibility metadata, and launch-failure surfacing)";

const PLUGIN_ID = "acme-agent";
const PLUGIN_NAME = "ACME Agent";
const PLUGIN_VERSION = "1.2.0";
const MIN_VERSION = "1.4.0";
const TESTED_CEILING = "2.1.7";
const STAGING_TOKEN = "staging-acme-agent";
const FETCHED_AT = "2026-08-03T00:00:00.000Z";

const FIRST_PARTY_STATUS: MarketplaceSourceStatus = {
  id: FIRST_PARTY_SOURCE_ID,
  url: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
  label: "Roubo first-party",
  source: "network",
  fetchedAt: FETCHED_AT,
  unavailable: false,
};

/**
 * The newly published agent listing as the server projects it. `verified: false`
 * because a third-party submission is not first-party curated, so it wears the
 * Unverified treatment; `agentCompatibility` is the derived pre-install window,
 * which is null for a release entry today (see the S005-O02 reconciliation above).
 */
function agentListing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    kind: "agent",
    version: PLUGIN_VERSION,
    summary: "Run benches on the ACME agent CLI.",
    source: { type: "release", assetUrl: "https://releases.acme.example/acme-agent-1.2.0.tgz" },
    provenance: "github.com/acme/roubo-acme-agent",
    integrity: "sha256-acme",
    verified: false,
    installed: false,
    installedVersion: null,
    updateAvailable: false,
    declaredPermissions: null,
    lifecycle: null,
    agentCompatibility: null,
    sourceId: FIRST_PARTY_SOURCE_ID,
    ...over,
  };
}

/** A component listing that must NOT survive the Agent kind filter. */
function componentListing(): MarketplaceListing {
  return {
    ...agentListing(),
    id: "redis",
    name: "Redis",
    kind: "component",
    version: "1.3.0",
    summary: "A Redis cache component.",
    source: { type: "git", url: "https://example.com/redis.git" },
    provenance: "roubo/plugins@redis",
    integrity: "sha256-redis",
    verified: true,
    agentCompatibility: null,
  };
}

/** The staged manifest the install preview carries, as read off the published artifact. */
function agentManifest(): PluginManifest {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: "A third-party agent plugin published to the hosted marketplace.",
    kind: "agent",
    roubo: "^1.0.0",
    entry: "dist/index.js",
    agentCompatibility: { minVersion: MIN_VERSION, testedCeiling: TESTED_CEILING },
    permissions: {
      network: { hosts: ["api.acme.example"] },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: false,
    },
  } as PluginManifest;
}

function agentPreview(): InstallPreview {
  return {
    stagingToken: STAGING_TOKEN,
    manifest: agentManifest(),
    source: { type: "release", assetUrl: "https://releases.acme.example/acme-agent-1.2.0.tgz" },
  };
}

// Mutable catalog state, so the confirm mutation's real cache invalidation re-reads
// the post-install shape.
let catalogListings: MarketplaceListing[];

function setCatalog(listings: MarketplaceListing[]) {
  catalogListings = listings;
}

function renderMarketplace() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={client}>
      <Marketplace />
    </QueryClientProvider>,
  );
  return { user, ...utils };
}

beforeEach(() => {
  vi.clearAllMocks();
  setCatalog([componentListing(), agentListing()]);
  // The kind filter is applied SERVER-side (the catalog query carries `kind`), so
  // the mocked boundary honours it rather than letting the grid appear to filter.
  mockedFetch.mockImplementation((params?: { q?: string; kind?: string }) =>
    Promise.resolve({
      curated: true,
      listings: catalogListings.filter((l) => params?.kind === undefined || l.kind === params.kind),
      source: "network",
      fetchedAt: FETCHED_AT,
      sources: [FIRST_PARTY_STATUS],
    }),
  );
  mockedInstall.mockResolvedValue(agentPreview());
  mockedUpdate.mockResolvedValue(agentPreview());
  mockedConfirm.mockResolvedValue({ plugin: { id: PLUGIN_ID } } as Awaited<
    ReturnType<typeof confirmInstallPlugin>
  >);
  mockedCancel.mockResolvedValue(undefined);
  mockedGrantConsent.mockResolvedValue({
    pluginId: PLUGIN_ID,
    acknowledgedCategories: ["network"],
    consentedAt: FETCHED_AT,
  });
});

describe("AP-TC-118 S005/S006: the published agent plugin's marketplace listing and Install button", () => {
  it("S005-O01: the newly published plugin appears as an agent-kind listing with an Install affordance", async () => {
    const { user, findByTestId, getAllByTestId, getByTestId } = renderMarketplace();
    await findByTestId("marketplace-grid");

    // Scope to the Agent kind, which is the chip a user browsing agent plugins
    // presses. The catalog query re-fetches with kind=agent, so wait for the
    // component card to detach before reading: the query holds placeholderData
    // deliberately, and reading the stale grid would pass on a broken filter.
    await user.click(getByTestId("marketplace-filter-agent"));
    await waitFor(() =>
      expect(
        getAllByTestId("marketplace-card").map((c) => c.getAttribute("data-plugin-id")),
        `AP-TC-118 step S005 (S005-O01) diverged: expected the Agent filter to scope the grid to agent-kind listings only. Owning slice: ${SLICE_MARKETPLACE}.`,
      ).toEqual([PLUGIN_ID]),
    );

    const card = getAllByTestId("marketplace-card")[0];
    expect(
      within(card).getByTestId("marketplace-card-kind").getAttribute("data-kind"),
      `AP-TC-118 step S005 (S005-O01) diverged: expected the newly published listing to be marked agent-kind, got "${within(card).getByTestId("marketplace-card-kind").getAttribute("data-kind")}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe("agent");
    expect(card).toHaveTextContent(PLUGIN_NAME);
    // Never installed by this user, so the card offers Install rather than the
    // Installed badge.
    expect(
      within(card).queryByTestId("marketplace-card-install"),
      `AP-TC-118 step S005 (S005-O01) diverged: expected an Install affordance on a listing this user has never installed. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBeInTheDocument();
    expect(within(card).queryByTestId("marketplace-card-installed")).not.toBeInTheDocument();
  });

  it("S005-O02: the listing renders the declared floor and tested ceiling when the projection supplies them", async () => {
    setCatalog([
      agentListing({
        agentCompatibility: { minVersion: MIN_VERSION, testedCeiling: TESTED_CEILING },
      }),
    ]);
    const { findByTestId, getAllByTestId } = renderMarketplace();
    await findByTestId("marketplace-grid");

    const compatibility = within(getAllByTestId("marketplace-card")[0]).getByTestId(
      "marketplace-card-agent-compatibility",
    );
    expect(
      compatibility.getAttribute("data-declared"),
      `AP-TC-118 step S005 (S005-O02) diverged: expected the agent listing to display its declared compatibility metadata, got data-declared="${compatibility.getAttribute("data-declared")}". Owning slice: ${SLICE_COMPAT}.`,
    ).toBe("true");
    expect(
      compatibility.textContent,
      `AP-TC-118 step S005 (S005-O02) diverged: expected the listing to name the version floor ${MIN_VERSION} and the tested ceiling ${TESTED_CEILING}, got "${compatibility.textContent}". Owning slice: ${SLICE_COMPAT}.`,
    ).toContain(MIN_VERSION);
    expect(compatibility.textContent).toContain(TESTED_CEILING);
  });

  it("S005-O02 (reconciled): a listing whose projected window is null renders the undeclared fallback", async () => {
    // The card half of the reconciliation, and only that. A genuinely published
    // plugin projects a null window today (the server cannot read a release
    // entry's manifest pre-install), and this pins what the card does with a null:
    // the "compatibility not declared" fallback (AP-TC-121). The fixture hardcodes
    // the null, so this test does NOT observe the projection and will keep passing
    // after davidpoxon/roubo-development#722 widens it. The assertion that fails
    // when #722 lands is the server one, over the real `listCatalog()` result.
    setCatalog([agentListing()]);
    const { findByTestId, getAllByTestId } = renderMarketplace();
    await findByTestId("marketplace-grid");

    const compatibility = within(getAllByTestId("marketplace-card")[0]).getByTestId(
      "marketplace-card-agent-compatibility",
    );
    expect(
      compatibility.getAttribute("data-declared"),
      `AP-TC-118 step S005 (S005-O02) diverged: expected a listing whose projected window is null to fall back to "compatibility not declared", got data-declared="${compatibility.getAttribute("data-declared")}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe("false");
    expect(compatibility).toHaveTextContent("compatibility not declared");
  });

  it("S006-O01: pressing Install stages the published package and confirming installs it", async () => {
    setCatalog([agentListing()]);
    const { user, findByTestId, getAllByTestId, getByTestId, queryByTestId } = renderMarketplace();
    await findByTestId("marketplace-grid");

    // The Install button drives the real install-preview mutation, which is the
    // client end of the integrity-verified staging the server guard exercises: a
    // preview exists only because the digest recomputed over the downloaded bytes
    // matched the catalog's declaration.
    await user.click(
      within(getAllByTestId("marketplace-card")[0]).getByTestId("marketplace-card-install"),
    );
    await waitFor(() =>
      expect(
        mockedInstall,
        `AP-TC-118 step S006 (S006-O01) diverged: expected the Install button to stage "${PLUGIN_ID}". Owning slice: ${SLICE_MARKETPLACE}.`,
      ).toHaveBeenCalledWith(PLUGIN_ID, undefined),
    );

    const modal = await findByTestId("marketplace-consent-modal");
    expect(
      within(modal).getByRole("heading"),
      `AP-TC-118 step S006 (S006-O01) diverged: expected the verified package to reach the single consent prompt for "${PLUGIN_NAME}". Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toHaveTextContent(`Install ${PLUGIN_NAME}?`);
    // The staged agent manifest's declared permissions are what the prompt lists.
    expect(
      within(modal).getByTestId("marketplace-consent-list").querySelectorAll("[data-category]")
        .length,
      `AP-TC-118 step S006 (S006-O01) diverged: expected the consent prompt to list the staged agent manifest's declared permission categories. Owning slice: ${SLICE_MARKETPLACE}.`,
    ).toBe(1);

    await user.click(within(getByTestId("marketplace-consent-ack")).getByRole("checkbox"));
    await waitFor(() =>
      expect(getByTestId("marketplace-consent-confirm").getAttribute("aria-disabled")).toBe(
        "false",
      ),
    );

    // The confirm mutation's success invalidates the catalog, so the reload must
    // observe the installed shape.
    setCatalog([agentListing({ installed: true, installedVersion: PLUGIN_VERSION })]);
    await user.click(getByTestId("marketplace-consent-confirm"));

    await waitFor(() =>
      expect(
        mockedConfirm,
        `AP-TC-118 step S006 (S006-O01) diverged: expected confirming the prompt to commit the staged package. Owning slice: ${SLICE_MARKETPLACE}.`,
      ).toHaveBeenCalledWith(STAGING_TOKEN),
    );
    await waitFor(() => expect(mockedGrantConsent).toHaveBeenCalledWith(PLUGIN_ID, ["network"]));
    await waitFor(() => expect(queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument());
    expect(addToast).toHaveBeenCalledWith(`Installed ${PLUGIN_NAME}.`);

    // Terminal state: the published plugin now reads as Installed on this user's
    // machine, with no install affordance left to press.
    await waitFor(() =>
      expect(
        within(getAllByTestId("marketplace-card")[0]).queryByTestId("marketplace-card-installed"),
        `AP-TC-118 step S006 (S006-O01) diverged: expected the listing to read Installed once the package is committed. Owning slice: ${SLICE_MARKETPLACE}.`,
      ).toBeInTheDocument(),
    );
    expect(
      within(getAllByTestId("marketplace-card")[0]).queryByTestId("marketplace-card-install"),
    ).not.toBeInTheDocument();
  });
});
