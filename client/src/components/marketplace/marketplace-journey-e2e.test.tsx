// @vitest-environment jsdom
//
// Integration-level E2E test for the marketplace install/update journey: a
// consumer browses the catalog, searches for Redis, installs it (with the
// fetched package's integrity verified server-side against the signed catalog),
// then updates it when a newer version is published, asserting the authoritative
// e2e_flow case CP-TC-101 step by step (issue #629).
//
// This is the journey's drift guard, mirroring client/src/permission-consent-e2e.test.tsx
// (the CP-TC-076 / #625 drift guard for the sibling consent journey): it
// exercises the integrated journey through the already-shipped, real seams of
// the slices it spans, rather than re-testing any single slice. The slices owned
// by this work unit are #621 (the catalog browse/search/install/update UI) and
// #622 (integrity verification). A failing step is localised back to the owning
// slice(s) via OWNING_SLICES below (FR-020).
//
// Hermetic by construction (matching the Marketplace.test.tsx precedent, but at
// a higher fidelity): a real QueryClientProvider, the REAL Marketplace component,
// and the REAL useMarketplace React Query hooks (useMarketplaceCatalog, the
// install/update preview mutations, and the confirm/cancel mutations with their
// real cache-invalidation seam), with only the `../../lib/api` boundary mocked
// (fetchMarketplaceCatalog, installFromMarketplace, updateFromMarketplace,
// confirmInstallPlugin, cancelInstallPlugin). No network, no real server. The
// useToast hook is mocked so addToast can be captured and emits no console noise.
//
// Integrity verification (CP-FR-021 / #622) is authoritatively server-side
// (#690: signed ed25519 catalog + per-entry sha256 digests, fail-closed) and has
// its own server tests. This client journey guard asserts the UI-observable
// integrity OUTCOMES (S005-O04 / S008-O04: after a successful confirm, no
// integrity error or signature warning is shown). The mocked confirm boundary
// resolving successfully represents the server having verified the package,
// exactly as permission-consent-e2e mocks the grantPluginConsent boundary.
//
// FIDELITY NOTE (asserts the real SHIPPED behaviour; changing production strings
// is explicitly out of scope for this e2e work unit). Three points of CP-TC-101's
// authoritative prose diverge from the shipped marketplace UX. This guard asserts
// the shipped behaviour and the divergences are tracked for reconciliation in
// #693 (mirroring how permission-consent-e2e references #678):
//   1. Toast text: the shipped Marketplace emits "Installed Redis." / "Updated
//      Redis." (STRINGS.installedToast = `Installed ${name}.`), NOT TC-101's
//      "Installed Redis · roubo/redis" / "Updated Redis · roubo/redis"
//      (S005-O02 / S008-O02).
//   2. Consent plugin id: the shipped MarketplaceConsentModal shows manifest.id =
//      "redis", NOT TC-101's "roubo/redis" (S003-O02).
//   3. Consent trust icon: the shipped MarketplaceConsentModal renders a
//      ShieldAlert icon (the page-header curated badge and card verified marker
//      use ShieldCheck); TC-101 S003-O03 says "shield-check icon". This guard
//      asserts the trust banner's content/role via data-testid
//      "marketplace-consent-trust" and its "Verified, first-party" text, NOT the
//      exact icon.
// S001 NOTE: there is no sidebar-navigation seam in this hermetic render; "Click
// 'Marketplace' in the sidebar" (S001) is satisfied by rendering the real
// Marketplace view directly and asserting its grid is present, since the routing
// that mounts it is not part of either spanned slice.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstallPreview, MarketplaceListing, PluginManifest } from "@roubo/shared";
import Marketplace from "./Marketplace";

// Mock ONLY the api boundary in ../../lib/api; everything else (the real
// Marketplace, the real useMarketplace hooks and their cache-invalidation seam,
// declaredCategories, the consent modal) runs for real.
vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return {
    ...actual,
    fetchMarketplaceCatalog: vi.fn(),
    installFromMarketplace: vi.fn(),
    updateFromMarketplace: vi.fn(),
    confirmInstallPlugin: vi.fn(),
    cancelInstallPlugin: vi.fn(),
  };
});

// useToast's addToast emits the install/update success toast (and any error).
// Mock it so the toast call can be captured and no console noise escapes.
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
} from "../../lib/api";

const mockedFetch = vi.mocked(fetchMarketplaceCatalog);
const mockedInstall = vi.mocked(installFromMarketplace);
const mockedUpdate = vi.mocked(updateFromMarketplace);
const mockedConfirm = vi.mocked(confirmInstallPlugin);
const mockedCancel = vi.mocked(cancelInstallPlugin);

// The slices this journey integrates, from #629's covers / blocked-by set.
// Reported when a step diverges so a failure is attributable to a slice (FR-020).
const OWNING_SLICES = "#621, #622";

const PLUGIN_ID = "redis";
const PLUGIN_NAME = "Redis";

// ── Fixtures ──

function redisListing(over: Partial<MarketplaceListing> = {}): MarketplaceListing {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
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
    ...over,
  };
}

const OTHER_LISTINGS: MarketplaceListing[] = [
  redisListing({
    id: "github-com",
    name: "GitHub.com",
    kind: "integration",
    version: "0.2.0",
    summary: "Connect GitHub issues to benches.",
    installed: true,
    installedVersion: "0.2.0",
  }),
  redisListing({
    id: "worker-queue",
    name: "Worker Queue",
    kind: "component",
    version: "1.1.0",
    summary: "A background job worker.",
    installed: false,
  }),
];

// The redis manifest the staged install preview carries. Its permissions declare
// EXACTLY ports then docker (empty network/credentials/filesystem, processes
// false), so declaredCategories() surfaces ["ports", "docker"] and nothing else.
function redisManifest(version: string): PluginManifest {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    version,
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
  } as PluginManifest;
}

function installPreview(version: string): InstallPreview {
  return {
    stagingToken: `staging-${version}`,
    manifest: redisManifest(version),
    source: { type: "git", url: "https://example.com/redis.git" },
  };
}

// ── Mutable catalog state, so S006 can flip the registry to the update-available
// shape and the real confirm-mutation cache invalidation re-fetches it. The
// fetch mock honours the `q` param exactly as the real server does (server-side
// search), so typing "redis" filters the grid to the Redis card. ──

let redisState: MarketplaceListing;

function currentListings(): MarketplaceListing[] {
  return [redisState, ...OTHER_LISTINGS];
}

function matchesQuery(listing: MarketplaceListing, q: string | undefined): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    listing.id.toLowerCase().includes(needle) ||
    listing.name.toLowerCase().includes(needle) ||
    listing.summary.toLowerCase().includes(needle)
  );
}

// ── Canonical CP-TC-101 step sequence (single source of truth) ──
//
// The labels are both what each step runs under and the expected order the
// terminal drift guard asserts against: drop or reorder a step and the recorded
// run no longer equals TC101_SEQUENCE, so the test fails (mirrors TC076_SEQUENCE
// in the permission-consent-e2e precedent).
const TC101_STEPS = {
  browse: "S001 Consumer: the marketplace view renders the full plugin grid",
  search:
    "S002 Consumer: typing 'redis' filters the grid to only the Redis card, showing Install, a Verified indicator, and the current version",
  installConsent:
    "S003 Consumer: pressing Install opens the consent dialog titled 'Install Redis?' with id/kind/version, the trust banner, the docker+ports permission list, and a gated confirm",
  ackEnablesInstall:
    "S004 Consumer: ticking the acknowledgement checkbox enables the 'Install plugin' confirm",
  confirmInstall:
    "S005 Consumer: pressing confirm closes the dialog, fires the success toast, flips the card to Installed, and shows no integrity error (verified)",
  publishUpdate:
    "S006 Consumer: simulating the registry publishing v1.4.0 and reloading flips the card to Update with strikethrough-old + new version",
  updateConsent:
    "S007 Consumer: pressing Update opens the consent dialog titled 'Update Redis?' targeting v1.4.0 with the trust banner and permission list",
  confirmUpdate:
    "S008 Consumer: ticking ack and confirming closes the dialog, fires the update toast, shows v1.4.0 + the Installed badge, and shows no integrity/signature error (verified)",
} as const;
const TC101_SEQUENCE = [
  TC101_STEPS.browse,
  TC101_STEPS.search,
  TC101_STEPS.installConsent,
  TC101_STEPS.ackEnablesInstall,
  TC101_STEPS.confirmInstall,
  TC101_STEPS.publishUpdate,
  TC101_STEPS.updateConsent,
  TC101_STEPS.confirmUpdate,
];

// ── FR-020 failure-output wrapper ──
//
// Each CP-TC-101 step runs inside step(): on divergence it reports the diverging
// step label, the expected-vs-actual, and the owning slice issue(s), so a failure
// is attributable to a slice rather than the whole journey.
async function step<T>(label: string, expectation: string, body: () => T | Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `CP-TC-101 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${OWNING_SLICES}`,
      { cause },
    );
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  redisState = redisListing();
  mockedFetch.mockImplementation((params) =>
    Promise.resolve({
      curated: true,
      listings: currentListings().filter((l) => matchesQuery(l, params?.q)),
    }),
  );
  mockedInstall.mockResolvedValue(installPreview("1.3.0"));
  mockedUpdate.mockResolvedValue(installPreview("1.4.0"));
  mockedConfirm.mockResolvedValue({ plugin: { id: PLUGIN_ID } } as Awaited<
    ReturnType<typeof confirmInstallPlugin>
  >);
  mockedCancel.mockResolvedValue(undefined);
});

describe("Marketplace journey E2E (CP-TC-101): consumer browses, installs (integrity-verified), and updates", () => {
  it("runs the full journey end to end and matches CP-TC-101", async () => {
    const executed: string[] = [];
    const track = async <T,>(
      label: string,
      expectation: string,
      body: () => T | Promise<T>,
    ): Promise<T> => {
      const result = await step(label, expectation, body);
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

    // S001: the marketplace view renders with the full plugin grid (#621). There
    // is no sidebar-navigation seam in this hermetic render (see S001 NOTE in the
    // header): rendering the real Marketplace and asserting its grid is the
    // equivalent of arriving on the view.
    await track(
      TC101_STEPS.browse,
      "marketplace-grid renders with all catalog cards (Redis + the other listings)",
      async () => {
        const grid = await findByTestId("marketplace-grid");
        expect(grid).toBeInTheDocument();
        const cards = getAllByTestId("marketplace-card");
        expect(cards.length).toBe(currentListings().length);
        const ids = cards.map((c) => c.getAttribute("data-plugin-id"));
        expect(ids).toContain(PLUGIN_ID);
      },
    );

    // S002: typing 'redis' into the search field filters the grid (server-side
    // search via the real catalog query re-key) to ONLY the Redis card, which
    // shows Install, a Verified indicator, and the current version (#621).
    await track(
      TC101_STEPS.search,
      "the grid filters to only the Redis card showing marketplace-card-install, 'Verified', and 'v1.3.0'",
      async () => {
        await user.type(getByTestId("marketplace-search"), PLUGIN_NAME.toLowerCase());
        await waitFor(() => {
          const cards = getAllByTestId("marketplace-card");
          expect(cards.length).toBe(1);
          expect(cards[0].getAttribute("data-plugin-id")).toBe(PLUGIN_ID);
        });
        const card = getAllByTestId("marketplace-card")[0];
        expect(within(card).getByTestId("marketplace-card-install")).toBeInTheDocument();
        expect(within(card).getByTestId("marketplace-card-verified")).toHaveTextContent("Verified");
        expect(within(card).getByTestId("marketplace-card-version")).toHaveTextContent("v1.3.0");
      },
    );

    // S003: pressing Install stages a preview (real install-preview mutation),
    // and the consent dialog opens titled 'Install Redis?'. It shows the id/kind/
    // version line, the trust banner (content/role, NOT the exact icon, per the
    // FIDELITY NOTE: shipped renders ShieldAlert), the docker+ports permission
    // items in plain language, and the confirm is gated (aria-disabled) while the
    // acknowledgement is unchecked (#621).
    await track(
      TC101_STEPS.installConsent,
      "marketplace-consent-modal opens titled 'Install Redis?' with the id/kind/version line, the trust banner, exactly the ports+docker permission items, and an aria-disabled confirm",
      async () => {
        await user.click(getByTestId("marketplace-card-install"));
        const modal = await findByTestId("marketplace-consent-modal");
        expect(modal).toBeInTheDocument();
        expect(within(modal).getByRole("heading")).toHaveTextContent("Install Redis?");

        // FIDELITY: shipped shows manifest.id "redis" and kind "component plugin"
        // and version "v1.3.0" (NOT TC-101's "roubo/redis" id; see #693).
        expect(modal.textContent).toContain(PLUGIN_ID);
        expect(modal.textContent).toMatch(/component plugin/i);
        expect(modal.textContent).toContain("v1.3.0");

        // Trust banner: assert its content/role, NOT the icon (see FIDELITY NOTE
        // #693: shipped renders ShieldAlert, TC-101 says shield-check).
        const trust = within(modal).getByTestId("marketplace-consent-trust");
        expect(trust).toBeInTheDocument();
        expect(trust.textContent).toMatch(/Verified, first-party/i);

        // Permission list: EXACTLY ports then docker, in plain language.
        const list = within(modal).getByTestId("marketplace-consent-list");
        const categories = Array.from(list.querySelectorAll("[data-category]")).map((el) =>
          el.getAttribute("data-category"),
        );
        expect(categories).toEqual(["ports", "docker"]);
        expect(within(list).getByText(/Network ports/)).toBeInTheDocument();
        expect(within(list).getByText(/Allocate bench ports: redis\./)).toBeInTheDocument();
        expect(within(list).getByText(/^Docker$/)).toBeInTheDocument();
        expect(
          within(list).getByText(/Manage Docker containers via the host broker\./),
        ).toBeInTheDocument();

        // Confirm gated until ack (aria-disabled, NOT native disabled, NFR-007).
        const confirm = within(modal).getByTestId("marketplace-consent-confirm");
        expect(confirm.getAttribute("aria-disabled")).toBe("true");
        expect(confirm).not.toBeDisabled();
      },
    );

    // S004: ticking the acknowledgement checkbox enables the 'Install plugin'
    // confirm (aria-disabled flips to false) (#621).
    await track(
      TC101_STEPS.ackEnablesInstall,
      "ticking marketplace-consent-ack flips marketplace-consent-confirm to aria-disabled false",
      async () => {
        await user.click(within(getByTestId("marketplace-consent-ack")).getByRole("checkbox"));
        await waitFor(() => {
          expect(getByTestId("marketplace-consent-confirm").getAttribute("aria-disabled")).toBe(
            "false",
          );
        });
      },
    );

    // S005: pressing confirm fires the real confirm mutation (whose success
    // represents the server having verified the package integrity against the
    // signed catalog, CP-FR-021). The dialog closes, the success toast fires, the
    // card flips to Installed, and NO integrity error / consent error is shown
    // (S005-O04). FIDELITY: shipped toast is "Installed Redis." (no "· roubo/redis"
    // suffix; see #693).
    await track(
      TC101_STEPS.confirmInstall,
      "confirm closes the dialog, addToast fires the shipped install toast, the card shows Installed, and no integrity/consent error is shown",
      async () => {
        // The confirm-mutation onSuccess invalidates the marketplace query; the
        // refetch must observe the plugin as installed so the card re-annotates.
        redisState = redisListing({ installed: true, installedVersion: "1.3.0" });

        await user.click(getByTestId("marketplace-consent-confirm"));

        await waitFor(() => {
          expect(mockedConfirm).toHaveBeenCalledWith("staging-1.3.0");
        });
        // Dialog closes.
        await waitFor(() => {
          expect(queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
        });
        // Shipped success toast (no "· roubo/redis" suffix; #693).
        expect(addToast).toHaveBeenCalledWith("Installed Redis.");
        // Card flips to Installed (the invalidated catalog re-fetched as installed).
        await waitFor(() => {
          const card = getAllByTestId("marketplace-card")[0];
          expect(within(card).getByTestId("marketplace-card-installed")).toBeInTheDocument();
        });
        // Integrity outcome (S005-O04): no integrity / signature error surfaced.
        expect(queryByTestId("marketplace-consent-error")).not.toBeInTheDocument();
        expect(queryByTestId("marketplace-error")).not.toBeInTheDocument();
      },
    );

    // S006: simulate the registry publishing v1.4.0 by flipping the mocked
    // catalog to the update-available shape and invalidating the marketplace
    // query (the real reload seam). The card flips to Update and shows the old
    // version struck through alongside the new version (#621).
    await track(
      TC101_STEPS.publishUpdate,
      "after the registry publishes v1.4.0 and the catalog reloads, the card shows marketplace-card-update with strikethrough v1.3.0 and v1.4.0",
      async () => {
        redisState = redisListing({
          installed: true,
          installedVersion: "1.3.0",
          version: "1.4.0",
          updateAvailable: true,
        });
        await client.invalidateQueries({ queryKey: ["marketplace"] });

        await waitFor(() => {
          const card = getAllByTestId("marketplace-card")[0];
          expect(within(card).getByTestId("marketplace-card-update")).toBeInTheDocument();
        });
        const versionCell = within(getAllByTestId("marketplace-card")[0]).getByTestId(
          "marketplace-card-version",
        );
        // Old version struck through, new version shown.
        const struck = versionCell.querySelector(".line-through");
        expect(struck).not.toBeNull();
        expect(struck?.textContent).toContain("v1.3.0");
        expect(versionCell.textContent).toContain("v1.4.0");
      },
    );

    // S007: pressing Update stages the update preview (real update-preview
    // mutation) and opens the consent dialog titled 'Update Redis?' targeting
    // v1.4.0, with the trust banner and the permission list present and accurate
    // for the updated version (#621).
    await track(
      TC101_STEPS.updateConsent,
      "marketplace-consent-modal opens titled 'Update Redis?' targeting v1.4.0 with the trust banner and the ports+docker permission list",
      async () => {
        await user.click(getByTestId("marketplace-card-update"));
        const modal = await findByTestId("marketplace-consent-modal");
        expect(within(modal).getByRole("heading")).toHaveTextContent("Update Redis?");
        expect(modal.textContent).toContain("v1.4.0");
        expect(within(modal).getByTestId("marketplace-consent-trust").textContent).toMatch(
          /Verified, first-party/i,
        );
        const list = within(modal).getByTestId("marketplace-consent-list");
        const categories = Array.from(list.querySelectorAll("[data-category]")).map((el) =>
          el.getAttribute("data-category"),
        );
        expect(categories).toEqual(["ports", "docker"]);
      },
    );

    // S008: ticking the acknowledgement and confirming fires the real confirm
    // mutation (server-verified update package). The dialog closes, the update
    // toast fires, the card shows v1.4.0 + the Installed badge, and NO integrity /
    // signature error is shown (S008-O04). FIDELITY: shipped toast is "Updated
    // Redis." (no "· roubo/redis" suffix; #693).
    await track(
      TC101_STEPS.confirmUpdate,
      "ticking ack + confirm closes the dialog, addToast fires the shipped update toast, the card shows v1.4.0 + Installed, and no integrity/signature error is shown",
      async () => {
        // After confirming the update, the reloaded catalog shows v1.4.0 installed.
        redisState = redisListing({ installed: true, installedVersion: "1.4.0", version: "1.4.0" });

        await user.click(within(getByTestId("marketplace-consent-ack")).getByRole("checkbox"));
        await waitFor(() => {
          expect(getByTestId("marketplace-consent-confirm").getAttribute("aria-disabled")).toBe(
            "false",
          );
        });
        await user.click(getByTestId("marketplace-consent-confirm"));

        await waitFor(() => {
          expect(mockedConfirm).toHaveBeenCalledWith("staging-1.4.0");
        });
        await waitFor(() => {
          expect(queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
        });
        // Shipped update toast (no "· roubo/redis" suffix; #693).
        expect(addToast).toHaveBeenCalledWith("Updated Redis.");
        // Card shows the new version in monospace and the Installed badge.
        await waitFor(() => {
          const card = getAllByTestId("marketplace-card")[0];
          expect(within(card).getByTestId("marketplace-card-installed")).toBeInTheDocument();
        });
        const card = getAllByTestId("marketplace-card")[0];
        const versionCell = within(card).getByTestId("marketplace-card-version");
        expect(versionCell).toHaveTextContent("v1.4.0");
        // Installed-current version renders in monospace (the cell itself carries
        // the font-mono class in the non-update branch of MarketplaceCard).
        expect(versionCell.className).toContain("font-mono");
        // Integrity outcome (S008-O04): no integrity / signature error surfaced.
        expect(queryByTestId("marketplace-consent-error")).not.toBeInTheDocument();
        expect(queryByTestId("marketplace-error")).not.toBeInTheDocument();
      },
    );

    // Terminal drift guard: the integrated run matches CP-TC-101's step sequence
    // end to end. A dropped or reordered step makes executed != TC101_SEQUENCE.
    expect(executed).toEqual(TC101_SEQUENCE);
  });

  // FR-020: prove the failure-output wrapper localises a diverging step,
  // reporting the diverging label, expected-vs-actual, and the owning slices.
  it("on failure reports the diverging step, expected-vs-actual, and owning slices", async () => {
    await expect(
      step(TC101_STEPS.confirmInstall, "the confirm mutation fires", () => {
        throw new Error("confirmInstallPlugin was never called");
      }),
    ).rejects.toThrow(/CP-TC-101 step diverged/);

    const captured = await step(TC101_STEPS.confirmInstall, "the confirm mutation fires", () => {
      throw new Error("confirmInstallPlugin was never called");
    }).catch((e: Error) => e.message);

    expect(captured).toContain("expected: the confirm mutation fires");
    expect(captured).toContain("actual:   confirmInstallPlugin was never called");
    expect(captured).toContain(`owning slice(s): ${OWNING_SLICES}`);
  });
});
