// @vitest-environment jsdom
//
// Integration-level E2E test for the trust-visibility + collision journey: a
// consumer browses a merged multi-source catalog, sees third-party entries
// rendered Unverified across the card and drawer surfaces while first-party is
// unambiguously Verified, finds the 'process' id served by two sources (a marked
// collision that refuses to silently pick a winner), is blocked from installing
// it until they explicitly choose a source, and finally installs it from the
// unsigned ACME source, where it lands Unverified with its ACME provenance
// recorded. It asserts the authoritative e2e_flow case CPHMTP-TC-047 step by step
// (issue #573).
//
// This is the journey's drift guard: it exercises the integrated journey through
// the already-shipped, real seams of the slices it spans (#558 the cross-source
// collision + pick-a-source refusal, #563 the single shared trust treatment),
// rather than re-testing any single slice. A failing step is localised back to the
// owning slice(s) via OWNERS below (CPHMTP-FR-020 / AC-7): each step() reports the
// diverging label, the expected-vs-actual, and the owning slice issue(s) from the
// issue's "Blocked by" set.
//
// Hermetic by construction (matching the marketplace-journey-e2e.test.tsx
// precedent): a real QueryClientProvider, the REAL Marketplace / MarketplaceCard /
// MarketplaceDrawer / MarketplaceConsentModal / ProvenanceBadge components, and the
// REAL useMarketplace React Query hooks (catalog query, install-preview mutation,
// and the confirm mutation with its real cache-invalidation seam), with only the
// `../../lib/api` boundary mocked. The useToast hook is mocked so addToast can be
// captured and no console noise escapes.
//
// FIDELITY NOTE (asserts the real SHIPPED behaviour; changing production strings
// is out of scope for this e2e work unit). CPHMTP-TC-047's prose says first-party
// entries show "Verified, first-party" (comma). The shipped ProvenanceBadge trust
// pill renders "Verified · first-party" (middle dot); the consent modal's trust
// lead uses the comma form. This guard asserts the shipped pill's data-treatment
// ("verified") plus its "Verified" and "first-party" text, not the exact
// punctuation. NON-DISMISSIBILITY (S002): the Unverified badge is non-dismissible
// BY CONSTRUCTION (ProvenanceBadge has no close affordance, no dismissal state, no
// override prop), so this guard asserts the ABSENCE of any dismiss control inside
// the badge rather than attempting a dismiss action.

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
import { ApiError } from "../../lib/api";
import Marketplace from "./Marketplace";

// Mock ONLY the api boundary in ../../lib/api; everything else (the real
// Marketplace, the real useMarketplace / useGrantConsent hooks and their
// cache-invalidation seam, the consent modal) runs for real. `importOriginal`
// preserves the real ApiError class, so `err instanceof ApiError` inside
// Marketplace still matches the ambiguity refusal this test throws.
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

// The issue's full "Blocked by" set, reported when the failure-output wrapper
// cannot attribute a divergence to a single slice.
const PROCESS_ID = "process";
const ACME_WIDGET_ID = "acme-widget";
const ACME_SOURCE_ID = "marketplace-acme-example-1a2b3c4d";
const ACME_LABEL = "ACME workplace";
const FETCHED_AT = "2026-07-02T00:00:00.000Z";
const PROCESS_STAGING_TOKEN = "staging-process";

// ── Fixtures ──

function listing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: "redis",
    name: "Redis",
    kind: "component",
    version: "1.3.0",
    summary: "A Redis cache component.",
    source: { type: "git", url: "https://example.com/redis.git" },
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

const FIRST_PARTY_STATUS: MarketplaceSourceStatus = {
  id: FIRST_PARTY_SOURCE_ID,
  url: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
  label: "Roubo first-party",
  source: "network",
  fetchedAt: null,
  unavailable: false,
};

const ACME_STATUS: MarketplaceSourceStatus = {
  id: ACME_SOURCE_ID,
  url: "https://marketplace.acme.example/catalog.json",
  label: ACME_LABEL,
  source: "network",
  fetchedAt: FETCHED_AT,
  unavailable: false,
};

const SOURCES = [FIRST_PARTY_STATUS, ACME_STATUS];

// The id served by BOTH the first-party catalog and the unsigned ACME source:
// two cards, each annotated with the same collision set, neither presented as the
// winner (CPHMTP-FR-005, issue #558).
const COLLISION_SOURCES = [FIRST_PARTY_SOURCE_ID, ACME_SOURCE_ID];

// The browse catalog: a clean first-party entry, a plain third-party entry (the
// S002 card->drawer badge subject), and the two colliding 'process' entries.
function browseCatalog(): MarketplaceListing[] {
  return [
    listing(),
    listing({
      id: ACME_WIDGET_ID,
      name: "ACME Widget",
      kind: "component",
      version: "0.4.0",
      summary: "A component from the ACME workplace source.",
      verified: false,
      sourceId: ACME_SOURCE_ID,
      provenance: "acme/widget",
    }),
    listing({
      id: PROCESS_ID,
      name: "Process",
      kind: "component",
      version: "2.0.0",
      summary: "Run a supervised long-running process.",
      provenance: "roubo/plugins@process",
      collision: { sourceIds: COLLISION_SOURCES },
    }),
    listing({
      id: PROCESS_ID,
      name: "Process",
      kind: "component",
      version: "2.0.0",
      summary: "Run a supervised long-running process.",
      verified: false,
      sourceId: ACME_SOURCE_ID,
      provenance: "acme/process",
      collision: { sourceIds: COLLISION_SOURCES },
    }),
  ];
}

// The staged install preview the mocked install boundary returns once a source is
// explicitly chosen. The process manifest declares `processes`, so the consent
// modal lists exactly that one category and the post-commit consent POST carries
// ["processes"].
function processManifest(): PluginManifest {
  return {
    id: PROCESS_ID,
    name: "Process",
    version: "2.0.0",
    description: "Run a supervised long-running process.",
    kind: "component",
    roubo: ">=0.1.0",
    entry: "index.js",
    permissions: {
      network: { hosts: [] },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: { executables: ["process"] },
      ports: false,
      docker: false,
    },
  } as PluginManifest;
}

function processPreview(): InstallPreview {
  return {
    stagingToken: PROCESS_STAGING_TOKEN,
    manifest: processManifest(),
    source: { type: "git", url: "https://marketplace.acme.example/process.git" },
  };
}

// An ApiError shaped exactly like the server's 409 ambiguous-source body
// (CPHMTP-FR-005): install/update of a colliding id with no source named is
// refused, and the refusal carries `sourceIds` on `details` so the banner can
// offer one explicit install-from choice per source.
function ambiguousError(): ApiError {
  return new ApiError('Plugin "process" is served by 2 sources.', 409, "ambiguous-source", {
    error: 'Plugin "process" is served by 2 sources.',
    code: "ambiguous-source",
    sourceIds: COLLISION_SOURCES,
  });
}

// ── Mutable catalog state, so the confirm-mutation's real cache invalidation can
// re-fetch the post-install shape (the ACME 'process' entry flipped to installed).
let catalogListings: MarketplaceListing[];

function installAcmeProcess() {
  catalogListings = catalogListings.map((l) =>
    l.id === PROCESS_ID && l.sourceId === ACME_SOURCE_ID
      ? { ...l, installed: true, installedVersion: l.version }
      : l,
  );
}

// ── Canonical CPHMTP-TC-047 step sequence (single source of truth) ──
//
// The labels are both what each step runs under and the expected order the
// terminal drift guard asserts against: drop or reorder a step and the recorded
// run no longer equals TC047_SEQUENCE, so the test fails (AC-6).
const TC047_STEPS = {
  browse:
    "S001 Consumer: the Browse grid renders third-party entries Unverified and first-party entries Verified, first-party, with no overlap between the two treatments",
  drawer:
    "S002 Consumer: a third-party plugin's card and its drawer both carry the Unverified badge, non-dismissible in both surfaces",
  collision:
    "S003 Consumer: the 'process' id shows the red 'Served by 2 sources' collision pill on both cards, naming both source provenances",
  blocked:
    "S004 Consumer: pressing Install on 'process' without a source is blocked by the pick-a-source banner; no source is chosen silently",
  chooseInstall:
    "S005 Consumer: choosing 'Install from ACME workplace' installs 'process' from the unsigned source, Unverified, recording the ACME provenance on the install record",
} as const;

const TC047_SEQUENCE = [
  TC047_STEPS.browse,
  TC047_STEPS.drawer,
  TC047_STEPS.collision,
  TC047_STEPS.blocked,
  TC047_STEPS.chooseInstall,
];

// The owning slice(s) per step, from the issue's Blocked by (#558, #563). Reported
// on divergence so a failure is attributable to the slice that owns the behaviour.
const OWNERS = {
  browse: "#563",
  drawer: "#563",
  collision: "#558",
  blocked: "#558",
  chooseInstall: "#558, #563",
} as const;

// ── AC-7 failure-output wrapper ──
//
// Each CPHMTP-TC-047 step runs inside step(): on divergence it reports the
// diverging step label, the expected-vs-actual, and the owning slice issue(s), so a
// failure is attributable to a slice rather than the whole journey.
async function step<T>(
  label: string,
  expectation: string,
  owners: string,
  body: () => T | Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `CPHMTP-TC-047 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${owners}`,
      { cause },
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  catalogListings = browseCatalog();
  mockedFetch.mockImplementation(() =>
    Promise.resolve({
      curated: true,
      listings: catalogListings,
      source: "network",
      fetchedAt: FETCHED_AT,
      sources: SOURCES,
    }),
  );
  // A colliding install with NO source named is refused; an explicit source (ACME)
  // proceeds to a staged preview.
  mockedInstall.mockImplementation((id: string, sourceId?: string) => {
    if (id === PROCESS_ID && sourceId === undefined) return Promise.reject(ambiguousError());
    return Promise.resolve(processPreview());
  });
  mockedUpdate.mockResolvedValue(processPreview());
  mockedConfirm.mockResolvedValue({ plugin: { id: PROCESS_ID } } as Awaited<
    ReturnType<typeof confirmInstallPlugin>
  >);
  mockedCancel.mockResolvedValue(undefined);
  mockedGrantConsent.mockResolvedValue({
    pluginId: PROCESS_ID,
    acknowledgedCategories: ["processes"],
    consentedAt: FETCHED_AT,
  });
});

describe("Marketplace trust-visibility + collision journey E2E (CPHMTP-TC-047)", () => {
  it("runs the full journey end to end and matches CPHMTP-TC-047", async () => {
    const executed: string[] = [];
    const track = async <T,>(
      label: string,
      expectation: string,
      owners: string,
      body: () => T | Promise<T>,
    ): Promise<T> => {
      const result = await step(label, expectation, owners, body);
      executed.push(label);
      return result;
    };

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    const { getByTestId, queryByTestId, getAllByTestId, findByTestId } = render(
      <QueryClientProvider client={client}>
        <Marketplace />
      </QueryClientProvider>,
    );

    // ── Local render helpers, scoped to the real merged grid ──
    const cards = (): HTMLElement[] => getAllByTestId("marketplace-card");
    const cardsFor = (id: string): HTMLElement[] =>
      cards().filter((c) => c.getAttribute("data-plugin-id") === id);
    const cardFor = (id: string): HTMLElement => {
      const [c] = cardsFor(id);
      if (!c) throw new Error(`expected a card for "${id}"`);
      return c;
    };
    const sourceIdOfCard = (card: HTMLElement): string | null =>
      within(card).getByTestId("provenance-source").getAttribute("data-source-id");
    const acmeProcessCard = (): HTMLElement => {
      const c = cardsFor(PROCESS_ID).find((card) => sourceIdOfCard(card) === ACME_SOURCE_ID);
      if (!c) throw new Error("expected the ACME 'process' card");
      return c;
    };
    const treatmentOf = (card: HTMLElement): string | null =>
      within(card).getByTestId("provenance-trust").getAttribute("data-treatment");
    // The badge is non-dismissible by construction: assert the ABSENCE of any
    // interactive dismiss/close affordance inside the trust badge unit.
    const assertBadgeNonDismissible = (badge: HTMLElement, where: string) => {
      const buttons = within(badge).queryAllByRole("button");
      if (buttons.length > 0) {
        throw new Error(`${where}: the Unverified badge exposes ${buttons.length} control(s)`);
      }
      if (
        badge.querySelector("[data-dismiss], [aria-label*='dismiss' i], [aria-label*='close' i]")
      ) {
        throw new Error(`${where}: the Unverified badge exposes a dismiss/close affordance`);
      }
    };

    // S001: the Browse grid renders. Third-party entries wear the Unverified
    // treatment, first-party entries the Verified treatment, and the two sets are
    // disjoint: no first-party card reads Unverified and no third-party card reads
    // Verified (CPHMTP-NFR-001, no state where a third-party entry gets first-party
    // styling) (owning #563).
    await track(
      TC047_STEPS.browse,
      "the grid shows verified first-party cards and unverified third-party cards, with the treatments never crossing sources",
      OWNERS.browse,
      async () => {
        await findByTestId("marketplace-grid");
        const all = cards();
        const verified = all.filter((c) => treatmentOf(c) === "verified");
        const unverified = all.filter((c) => treatmentOf(c) === "unverified");
        expect(verified.length).toBeGreaterThan(0);
        expect(unverified.length).toBeGreaterThan(0);
        // Every treatment is either verified or unverified: no third state.
        expect(verified.length + unverified.length).toBe(all.length);

        // Verified only ever appears on the first-party source, and says so.
        for (const c of verified) {
          expect(sourceIdOfCard(c)).toBe(FIRST_PARTY_SOURCE_ID);
          const trust = within(c).getByTestId("provenance-trust");
          expect(trust.textContent).toMatch(/Verified/);
          expect(trust.textContent).toMatch(/first-party/);
          expect(trust.textContent).not.toMatch(/Unverified/);
        }
        // Unverified only ever appears on a non-first-party source, with no
        // first-party wording to confuse it with the curated treatment.
        for (const c of unverified) {
          expect(sourceIdOfCard(c)).not.toBe(FIRST_PARTY_SOURCE_ID);
          const trust = within(c).getByTestId("provenance-trust");
          expect(trust.textContent).toMatch(/Unverified/);
          expect(trust.textContent).not.toMatch(/first-party/);
        }
      },
    );

    // S002: a third-party plugin's card AND its detail drawer both carry the
    // Unverified badge, and it is non-dismissible in both surfaces (owning #563).
    await track(
      TC047_STEPS.drawer,
      "the ACME Widget card and drawer both show the Unverified badge with no dismiss control",
      OWNERS.drawer,
      async () => {
        const card = cardFor(ACME_WIDGET_ID);
        const cardBadge = within(card).getByTestId("provenance-badge");
        expect(
          within(cardBadge).getByTestId("provenance-trust").getAttribute("data-treatment"),
        ).toBe("unverified");
        expect(within(cardBadge).getByTestId("provenance-trust")).toHaveTextContent("Unverified");
        assertBadgeNonDismissible(cardBadge, "card");

        // Open the detail drawer for the same entry.
        await user.click(within(card).getByTestId("marketplace-card-detail"));
        const drawer = await findByTestId("marketplace-drawer");
        const drawerBadge = within(drawer).getByTestId("provenance-badge");
        expect(
          within(drawerBadge).getByTestId("provenance-trust").getAttribute("data-treatment"),
        ).toBe("unverified");
        expect(within(drawerBadge).getByTestId("provenance-trust")).toHaveTextContent("Unverified");
        assertBadgeNonDismissible(drawerBadge, "drawer");

        // Close the drawer so its focus trap does not interfere with later steps.
        await user.click(within(drawer).getByTestId("marketplace-drawer-close"));
        await waitFor(() => expect(queryByTestId("marketplace-drawer")).not.toBeInTheDocument());
      },
    );

    // S003: the 'process' id is served by two sources, so BOTH cards render and
    // both are marked with the red 'Served by 2 sources' collision pill; neither is
    // presented as the winner, and the two source provenances are both present
    // (owning #558).
    await track(
      TC047_STEPS.collision,
      "both 'process' cards show a data-source-count=2 collision pill and together carry the first-party and ACME provenance chips",
      OWNERS.collision,
      async () => {
        const processCards = cardsFor(PROCESS_ID);
        expect(processCards.length).toBe(2);
        for (const c of processCards) {
          const pill = within(c).getByTestId("marketplace-card-collision");
          expect(pill).toHaveTextContent("Served by 2 sources");
          expect(pill.getAttribute("data-source-count")).toBe("2");
        }
        // Both provenances present, one per colliding card, no source shadowed.
        const provenanceSourceIds = processCards.map(sourceIdOfCard).sort();
        expect(provenanceSourceIds).toEqual([...COLLISION_SOURCES].sort());
      },
    );

    // S004: pressing Install on a colliding card sends NO source (the card must not
    // resolve the collision by which card was clicked), the server refuses with the
    // ambiguous-source 409, and the pick-a-source banner blocks: no consent modal
    // opens and no install proceeds silently (owning #558).
    await track(
      TC047_STEPS.blocked,
      "the install is refused with sourceId undefined and the ambiguous-source banner blocks, offering one explicit choice per source",
      OWNERS.blocked,
      async () => {
        await user.click(within(acmeProcessCard()).getByTestId("marketplace-card-install"));

        const banner = await findByTestId("marketplace-ambiguous-source");
        expect(banner).toHaveTextContent("Ambiguous source");
        // No silent resolution: no consent modal, and the refused preview carried
        // no source (precedence refused).
        expect(queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
        await waitFor(() => expect(mockedInstall).toHaveBeenCalledWith(PROCESS_ID, undefined));
        expect(mockedInstall).not.toHaveBeenCalledWith(PROCESS_ID, ACME_SOURCE_ID);

        // One explicit install-from choice per contributing source.
        const choices = within(banner).getAllByTestId("marketplace-ambiguous-choice");
        expect(choices.map((c) => c.getAttribute("data-source-id")).sort()).toEqual(
          [...COLLISION_SOURCES].sort(),
        );
      },
    );

    // S005: choosing 'Install from ACME workplace' re-issues the install NAMING the
    // ACME source, opens the consent modal for the unverified plugin, and on
    // ack + confirm commits and records the ACME provenance via the consent POST.
    // The reloaded catalog then shows the installed 'process' Unverified with its
    // ACME provenance chip (owning #558 for the pick, #563 for the trust outcome).
    await track(
      TC047_STEPS.chooseInstall,
      "the ACME choice installs 'process' from the unsigned source, Unverified, recording the ACME provenance on the install record",
      OWNERS.chooseInstall,
      async () => {
        const banner = getByTestId("marketplace-ambiguous-source");
        const acmeChoice = within(banner)
          .getAllByTestId("marketplace-ambiguous-choice")
          .find((c) => c.getAttribute("data-source-id") === ACME_SOURCE_ID);
        expect(acmeChoice).toBeDefined();
        expect(acmeChoice).toHaveTextContent(`Install from ${ACME_LABEL}`);
        await user.click(acmeChoice as HTMLElement);

        // The retry names the chosen source (no more ambiguity).
        await waitFor(() => expect(mockedInstall).toHaveBeenCalledWith(PROCESS_ID, ACME_SOURCE_ID));

        // Consent modal opens for the unverified, third-party plugin.
        const modal = await findByTestId("marketplace-consent-modal");
        expect(within(modal).getByRole("heading")).toHaveTextContent("Install Process?");
        expect(
          within(modal).getByTestId("marketplace-consent-trust").getAttribute("data-treatment"),
        ).toBe("unverified");
        expect(within(modal).getByTestId("marketplace-consent-trust")).toHaveTextContent(
          "Unverified, third-party",
        );
        // The trust badge inside the consent modal names the ACME source.
        expect(
          within(within(modal).getByTestId("marketplace-consent-trust"))
            .getByTestId("provenance-source")
            .getAttribute("data-source-id"),
        ).toBe(ACME_SOURCE_ID);

        // Acknowledge, which enables the gated confirm, then confirm.
        await user.click(within(getByTestId("marketplace-consent-ack")).getByRole("checkbox"));
        await waitFor(() =>
          expect(getByTestId("marketplace-consent-confirm").getAttribute("aria-disabled")).toBe(
            "false",
          ),
        );

        // The confirm-mutation success invalidates the catalog; the reload must
        // observe 'process' installed from ACME so the card re-annotates.
        installAcmeProcess();
        await user.click(getByTestId("marketplace-consent-confirm"));

        await waitFor(() => expect(mockedConfirm).toHaveBeenCalledWith(PROCESS_STAGING_TOKEN));
        // The install record's provenance is recorded via the consent POST for the
        // exact plugin, carrying its declared category.
        await waitFor(() =>
          expect(mockedGrantConsent).toHaveBeenCalledWith(PROCESS_ID, ["processes"]),
        );
        await waitFor(() =>
          expect(queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument(),
        );
        expect(addToast).toHaveBeenCalledWith("Installed Process.");

        // The installed 'process' renders Unverified with the ACME provenance chip.
        await waitFor(() =>
          expect(
            within(acmeProcessCard()).getByTestId("marketplace-card-installed"),
          ).toBeInTheDocument(),
        );
        const installedCard = acmeProcessCard();
        const trust = within(installedCard).getByTestId("provenance-trust");
        expect(trust.getAttribute("data-treatment")).toBe("unverified");
        expect(trust).toHaveTextContent("Unverified");
        expect(
          within(installedCard).getByTestId("provenance-source").getAttribute("data-source-id"),
        ).toBe(ACME_SOURCE_ID);
      },
    );

    // Terminal drift guard (AC-6): the integrated run matches CPHMTP-TC-047's step
    // sequence end to end. A dropped or reordered step makes executed != sequence.
    expect(executed).toEqual(TC047_SEQUENCE);
  });

  // AC-7: prove the failure-output wrapper localises a diverging step, reporting
  // the diverging label, expected-vs-actual, and the owning slice(s) from Blocked by.
  it("on failure reports the diverging step, expected-vs-actual, and owning slices", async () => {
    const captured = await step(
      TC047_STEPS.blocked,
      "the ambiguous-source banner blocks the install",
      OWNERS.blocked,
      () => {
        throw new Error("install proceeded without a source choice");
      },
    ).catch((e: Error) => e.message);

    expect(captured).toContain("CPHMTP-TC-047 step diverged");
    expect(captured).toContain(TC047_STEPS.blocked);
    expect(captured).toContain("expected: the ambiguous-source banner blocks the install");
    expect(captured).toContain("actual:   install proceeded without a source choice");
    expect(captured).toContain(`owning slice(s): ${OWNERS.blocked}`);
  });
});
