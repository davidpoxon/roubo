// @vitest-environment jsdom
//
// CP-NFR-007 (WCAG 2.1 AA): the marketplace catalog view and its install
// consent dialog must pass an axe-core scan and be keyboard operable. We scan
// the catalog grid and the gated consent modal (role=dialog, aria-modal, focus
// trap, amber focus rings, aria-disabled gating that stays keyboard reachable).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import type { InstallPreview, MarketplaceListing } from "@roubo/shared";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}

expect.extend({ toHaveNoViolations });

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
import MarketplaceConsentModal from "./MarketplaceConsentModal";

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
    verified: true,
    installed: false,
    installedVersion: null,
    updateAvailable: false,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockedCatalog.mockReturnValue({
    data: {
      curated: true,
      listings: [listing(), listing({ id: "github-com", kind: "integration" })],
    },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useCatalog>);
  mockedInstallPreview.mockReturnValue(mutationStub());
  mockedUpdatePreview.mockReturnValue(mutationStub());
  mockedConfirm.mockReturnValue(mutationStub());
  mockedCancel.mockReturnValue(mutationStub());
});

describe("Marketplace: axe-core (WCAG 2.1 AA, CP-NFR-007)", () => {
  it("has no axe violations in the catalog grid", async () => {
    const { baseElement } = render(<Marketplace />);
    const results = await axe(baseElement);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations in the gated consent modal", async () => {
    const { baseElement } = render(
      <MarketplaceConsentModal
        preview={preview()}
        mode="install"
        error={null}
        isPending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const results = await axe(baseElement);
    expect(results).toHaveNoViolations();
  });

  it("exposes a modal dialog and keeps the gated confirm control keyboard reachable", async () => {
    const user = userEvent.setup();
    const { getByRole, getByTestId } = render(
      <MarketplaceConsentModal
        preview={preview()}
        mode="install"
        error={null}
        isPending={false}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    const dialog = getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // The confirm control is aria-disabled while gated but remains focusable.
    const confirm = getByTestId("marketplace-consent-confirm");
    confirm.focus();
    expect(confirm).toHaveFocus();
    expect(confirm.getAttribute("aria-disabled")).toBe("true");

    // Ticking the acknowledgement enables the confirm control.
    await user.click(getByTestId("marketplace-consent-ack"));
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
