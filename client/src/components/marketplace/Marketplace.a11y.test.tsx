// @vitest-environment jsdom
//
// CP-NFR-007 (WCAG 2.1 AA): the marketplace catalog view and its install
// consent dialog must pass an axe-core scan and be keyboard operable. We scan
// the catalog grid and the gated consent modal (role=dialog, aria-modal, focus
// trap, amber focus rings, aria-disabled gating that stays keyboard reachable).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { InstallPreview, MarketplaceListing } from "@roubo/shared";
import { expectNoAxeFindings } from "../../test/axe";

vi.mock("../../hooks/useMarketplace");
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));
// Issue #399: Marketplace now calls useGrantConsent. Mock it so this scan needs
// no QueryClientProvider.
vi.mock("../../hooks/usePlugins", () => ({
  useGrantConsent: () => ({ mutate: vi.fn(), isPending: false }),
}));

import {
  useMarketplaceCatalog as _useCatalog,
  useMarketplaceInstallPreview as _useInstallPreview,
  useMarketplaceUpdatePreview as _useUpdatePreview,
  useMarketplaceInstallConfirm as _useConfirm,
  useMarketplaceInstallCancel as _useCancel,
} from "../../hooks/useMarketplace";
import Marketplace from "./Marketplace";
import MarketplaceConsentModal from "./MarketplaceConsentModal";
import type { PluginProvenance } from "./plugin-provenance";

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

function mutationStub<T>() {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false } as unknown as T;
}

function preview(): InstallPreview {
  return {
    stagingToken: "11111111-1111-1111-1111-111111111111",
    source: { type: "git", url: "https://example.com/r.git" },
    manifest: {
      id: "redis",
      name: "Redis",
      version: "1.3.0",
      description: "cache",
      kind: "component",
      roubo: "*",
      entry: "./index.js",
      permissions: {
        network: { hosts: ["redis.example.com"] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
        ports: { names: ["redis"] },
        docker: {},
      },
    },
  } as unknown as InstallPreview;
}

const FIRST_PARTY_STATUS = {
  id: FIRST_PARTY_SOURCE_ID,
  url: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
  label: "Roubo first-party",
  source: "network",
  fetchedAt: null,
  unavailable: false,
};

const ACME_SOURCE_ID = "marketplace-acme-example-1a2b3c4d";

const ACME_STATUS = {
  id: ACME_SOURCE_ID,
  url: "https://marketplace.acme.example/catalog.json",
  label: "ACME workplace",
  source: "network",
  fetchedAt: "2026-07-02T00:00:00.000Z",
  unavailable: false,
};

// The consent modal is handed the entry's provenance by its container (issue
// #563). These scans cover the first-party install; the unverified badge's own
// a11y is covered by the multi-source scans below, which list a third-party entry.
const A11Y_PROVENANCE: PluginProvenance = {
  sourceId: FIRST_PARTY_SOURCE_ID,
  sourceLabel: "Roubo first-party",
  curated: true,
  orphaned: false,
};

function setCatalogData(
  source: "network" | "cache",
  fetchedAt: string | null,
  over: {
    listings?: MarketplaceListing[];
    sources?: unknown[];
  } = {},
) {
  mockedCatalog.mockReturnValue({
    data: {
      curated: true,
      listings: over.listings ?? [listing(), listing({ id: "github-com", kind: "integration" })],
      source,
      fetchedAt,
      sources: over.sources ?? [FIRST_PARTY_STATUS],
    },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useCatalog>);
}

/** The merged multi-source surfaces: provenance chips plus the source chip row. */
function setMultiSourceData(over: { unavailable?: boolean } = {}) {
  setCatalogData("network", null, {
    listings: [listing(), listing({ id: "ghe", verified: false, sourceId: ACME_SOURCE_ID })],
    sources: [FIRST_PARTY_STATUS, { ...ACME_STATUS, unavailable: over.unavailable ?? false }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setCatalogData("network", null);
  mockedInstallPreview.mockReturnValue(mutationStub());
  mockedUpdatePreview.mockReturnValue(mutationStub());
  mockedConfirm.mockReturnValue(mutationStub());
  mockedCancel.mockReturnValue(mutationStub());
});

// CPHMTP-NFR-008 (issue #557): the new multi-source surfaces (per-entry
// provenance chips, the source filter chip row, the per-source unavailable
// notice) meet the same bar as the rest of this view.
describe("Marketplace multi-source surfaces: axe-core (CPHMTP-NFR-008)", () => {
  it("has no axe violations in the merged multi-source grid and filter chips", async () => {
    setMultiSourceData();
    const { baseElement } = render(<Marketplace />);
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("has no axe violations with a source reported unavailable", async () => {
    setMultiSourceData({ unavailable: true });
    const { baseElement } = render(<Marketplace />);
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("makes every source filter chip reachable and selectable by keyboard", async () => {
    const user = userEvent.setup();
    setMultiSourceData();
    render(<Marketplace />);

    // A radio group is one tab stop; arrow keys move within it. Tab to the group,
    // then walk to the ACME chip and select it without touching the mouse.
    const group = screen.getByRole("radiogroup", { name: "Filter by source" });
    const chips = within(group).getAllByRole("radio");
    // React Aria updates the radio's focus state on focus, so drive it through
    // act(): an unwrapped focus() would warn on stderr.
    act(() => chips[0].focus());
    expect(document.activeElement).toBe(chips[0]);

    await user.keyboard("{ArrowRight}{ArrowRight}");
    await waitFor(() => expect(chips[2]).toBeChecked());
    expect(mockedCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: ACME_SOURCE_ID }),
    );
  });
});

describe("Marketplace: axe-core (WCAG 2.1 AA, CP-NFR-007)", () => {
  it("has no axe violations in the catalog grid", async () => {
    const { baseElement } = render(<Marketplace />);
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  // CPHM-NFR-007 + issue #372: the offline / staleness banner (shown when the
  // catalog degraded off the network) must also be accessible.
  it("has no axe violations with the offline / staleness banner shown", async () => {
    setCatalogData("cache", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());
    const { baseElement, getByTestId } = render(<Marketplace />);
    expect(getByTestId("marketplace-offline-banner")).toBeInTheDocument();
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("has no axe violations in the gated consent modal", async () => {
    const { baseElement } = render(
      <MarketplaceConsentModal
        preview={preview()}
        provenance={A11Y_PROVENANCE}
        mode="install"
        error={null}
        isPending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("exposes a modal dialog and keeps the gated confirm control keyboard reachable", async () => {
    const user = userEvent.setup();
    const { getByRole, getByTestId } = render(
      <MarketplaceConsentModal
        preview={preview()}
        provenance={A11Y_PROVENANCE}
        mode="install"
        error={null}
        isPending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const dialog = getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // React Aria omits aria-modal deliberately and strips the prop, so the shared
    // stampAriaModal helper (issue #424) is what makes the modality explicit here.
    expect(dialog).toHaveAttribute("aria-modal", "true");

    // The confirm control is aria-disabled while gated but remains focusable.
    const confirm = getByTestId("marketplace-consent-confirm");
    confirm.focus();
    expect(confirm).toHaveFocus();
    expect(confirm.getAttribute("aria-disabled")).toBe("true");

    // Ticking the acknowledgement enables the confirm control.
    await user.click(within(getByTestId("marketplace-consent-ack")).getByRole("checkbox"));
    await waitFor(() => {
      expect(getByTestId("marketplace-consent-confirm").getAttribute("aria-disabled")).toBe(
        "false",
      );
    });

    // Tab cycles within the dialog (focus trap).
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
