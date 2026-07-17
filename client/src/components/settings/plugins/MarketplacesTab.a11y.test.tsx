// @vitest-environment jsdom
//
// CPHMTP-NFR-008 (WCAG 2.1 AA), verified by CPHMTP-TC-023 (issue #561): the
// Marketplaces settings section must pass an axe-core scan, be keyboard
// operable in a logical focus order, and announce each source row with its
// name, URL, and provenance status.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary } from "@roubo/shared";
import { expectNoAxeFindings } from "../../../test/axe";

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

const GHE: MarketplaceSourceSummary = {
  id: "marketplace-ghe-acme-internal-9f8e7d6c",
  url: "https://ghe.acme.internal/pages/dev-tools/roubo-marketplace/catalog.json",
  hasCredential: false,
  registeredAt: "2026-07-16T11:00:00.000Z",
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
  setSources([FIRST_PARTY, ACME, GHE]);
});

describe("MarketplacesTab: axe-core (WCAG 2.1 AA, CPHMTP-NFR-008 / TC-023 S003)", () => {
  it("has no axe findings in the populated source list", async () => {
    const { baseElement } = render(<MarketplacesTab />);
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("has no axe findings with only the non-removable first-party row", async () => {
    setSources([FIRST_PARTY]);
    const { baseElement } = render(<MarketplacesTab />);
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("has no axe findings in the error state", async () => {
    mockedSources.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("offline"),
    } as unknown as ReturnType<typeof _useSources>);
    const { baseElement } = render(<MarketplacesTab />);
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });
});

describe("MarketplacesTab: keyboard operability (TC-023 S001)", () => {
  it("reaches the Add control and every Remove control in a logical focus order", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTab />);

    const add = screen.getByRole("button", { name: "Add marketplace…" });
    // React Aria buttons update focus state on focus, so drive it through act():
    // an unwrapped focus() would warn on stderr.
    act(() => add.focus());
    expect(document.activeElement).toBe(add);

    // The Add entry point comes first, then one Remove per third-party row in
    // list order. The first-party row contributes no tab stop: it has no control.
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove marketplace.acme.example…" }),
    );

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Remove ghe.acme.internal…" }),
    );
  });

  it("gives every interactive control a visible focus indicator", () => {
    render(<MarketplacesTab />);
    const controls = [
      screen.getByRole("button", { name: "Add marketplace…" }),
      ...screen.getAllByTestId("marketplace-source-remove"),
    ];
    for (const control of controls) {
      expect(control.className).toContain("focus-visible:ring-2");
      expect(control.className).toContain("focus-visible:ring-amber-500");
    }
  });

  it("activates the Add control with the keyboard", async () => {
    const user = userEvent.setup();
    const onAddSource = vi.fn();
    render(<MarketplacesTab onAddSource={onAddSource} />);

    const add = screen.getByRole("button", { name: "Add marketplace…" });
    act(() => add.focus());
    await user.keyboard("{Enter}");
    expect(onAddSource).toHaveBeenCalledTimes(1);
  });
});

describe("MarketplacesTab: screen-reader labelling (TC-023 S002)", () => {
  it("names the section and the source list", () => {
    render(<MarketplacesTab />);
    expect(screen.getByRole("region", { name: "Marketplaces" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Registered marketplaces" })).toBeInTheDocument();
  });

  it("announces each row with its name, URL, and provenance status", () => {
    render(<MarketplacesTab />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    expect(rows[0].textContent).toContain("Roubo first-party");
    expect(rows[0].textContent).toContain(FIRST_PARTY.url);
    expect(rows[0].textContent).toContain("Verified, first-party");

    expect(rows[1].textContent).toContain("marketplace.acme.example");
    expect(rows[1].textContent).toContain(ACME.url);
    expect(rows[1].textContent).toContain("Unverified source");
  });

  it("gives the Add control an accessible name", () => {
    render(<MarketplacesTab />);
    expect(screen.getByRole("button", { name: "Add marketplace…" })).toBeInTheDocument();
  });

  it("distinguishes each Remove control by the source it removes", () => {
    render(<MarketplacesTab />);
    const removes = screen.getAllByTestId("marketplace-source-remove");
    const names = removes.map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual(["Remove marketplace.acme.example…", "Remove ghe.acme.internal…"]);
    // Every Remove control keeps its visible "Remove…" text inside the
    // accessible name (WCAG 2.5.3 label in name).
    for (const remove of removes) {
      expect(remove).toHaveTextContent("Remove…");
      expect(remove.getAttribute("aria-label")).toContain("Remove");
    }
  });

  it("keeps same-host sources' Remove controls distinguishable by their raw URL", () => {
    // The registry keys a source on its full normalised URL, so one host can
    // serve several distinct sources. The display name is only the host, so the
    // two Remove controls share an aria-label: each is described by its own row's
    // raw URL, which is what keeps them tellable apart.
    const teamA: MarketplaceSourceSummary = {
      id: "marketplace-ghe-acme-internal-aaaa1111",
      url: "https://ghe.acme.internal/team-a/catalog.json",
      hasCredential: false,
      registeredAt: "2026-07-16T11:00:00.000Z",
    };
    const teamB: MarketplaceSourceSummary = {
      id: "marketplace-ghe-acme-internal-bbbb2222",
      url: "https://ghe.acme.internal/team-b/catalog.json",
      hasCredential: false,
      registeredAt: "2026-07-16T12:00:00.000Z",
    };
    setSources([FIRST_PARTY, teamA, teamB]);
    render(<MarketplacesTab />);

    const removes = screen.getAllByTestId("marketplace-source-remove");
    expect(removes).toHaveLength(2);
    // The host-derived names alone are identical, so they cannot disambiguate.
    expect(removes.map((r) => r.getAttribute("aria-label"))).toEqual([
      "Remove ghe.acme.internal…",
      "Remove ghe.acme.internal…",
    ]);

    // Each control's description resolves to its own row's raw URL.
    const describedUrls = removes.map((remove) => {
      const id = remove.getAttribute("aria-describedby");
      expect(id).toBeTruthy();
      return document.getElementById(id as string)?.textContent;
    });
    expect(describedUrls).toEqual([teamA.url, teamB.url]);
    expect(new Set(describedUrls).size).toBe(2);
  });
});
