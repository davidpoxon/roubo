// @vitest-environment jsdom
//
// CPHMTP-NFR-008 (WCAG 2.1 AA), issue #565: the project-open registration offer
// is a warn banner a keyboard-only user must be able to read, act on, or decline.
// We scan the banner (and the consent dialog it opens) for axe findings and assert
// the banner exposes an accessible name and reachable actions.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary, RegisteredProject } from "@roubo/shared";
import { expectNoAxeFindings } from "../../test/axe";

vi.mock("../../hooks/useMarketplaceSources");
vi.mock("../../hooks/useMarketplace");
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ addToast: vi.fn() }) }));

import { useMarketplaceSources as _useSources } from "../../hooks/useMarketplaceSources";
import { useRegisterMarketplaceSource as _useRegister } from "../../hooks/useMarketplace";
import { DeclinedSourceOffersProvider } from "../DeclinedSourceOffersProvider";
import ProjectDeclaredSourceOffer from "./ProjectDeclaredSourceOffer";

const DECLARED_URL = "https://marketplace.acme.example/catalog.json";

const FIRST_PARTY_SUMMARY: MarketplaceSourceSummary = {
  id: FIRST_PARTY_SOURCE_ID,
  url: "https://davidpoxon.github.io/roubo-plugins/catalog.json",
  hasCredential: false,
  registeredAt: "1970-01-01T00:00:00.000Z",
};

function makeProject(): RegisteredProject {
  return {
    id: "acme-webapp",
    repoPath: "/repo/acme-webapp",
    configValid: true,
    settings: {} as RegisteredProject["settings"],
    config: { project: { displayName: "acme-webapp" }, marketplaces: [{ url: DECLARED_URL }] },
  } as unknown as RegisteredProject;
}

beforeEach(() => {
  vi.mocked(_useSources).mockReturnValue({
    data: { sources: [FIRST_PARTY_SUMMARY] },
  } as unknown as ReturnType<typeof _useSources>);
  vi.mocked(_useRegister).mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof _useRegister>);
});

function renderOffer() {
  return render(
    <DeclinedSourceOffersProvider>
      <ProjectDeclaredSourceOffer projectId="acme-webapp" project={makeProject()} />
    </DeclinedSourceOffersProvider>,
  );
}

describe("ProjectDeclaredSourceOffer: axe-core (CPHMTP-NFR-008)", () => {
  it("has no axe violations in the offer banner", async () => {
    const { baseElement } = renderOffer();
    expectNoAxeFindings(await axe(baseElement));
  });

  it("has no axe violations with the consent dialog open", async () => {
    const user = userEvent.setup();
    const { baseElement } = renderOffer();
    await user.click(screen.getByTestId("declared-source-offer-review"));
    expectNoAxeFindings(await axe(baseElement));
  });
});

describe("ProjectDeclaredSourceOffer: banner semantics (CPHMTP-NFR-008)", () => {
  it("exposes the banner as a named status region with reachable actions", () => {
    renderOffer();
    const banner = screen.getByTestId("declared-source-offer");
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/register the marketplace/i),
    );
    expect(screen.getByTestId("declared-source-offer-review")).toBeInTheDocument();
    expect(screen.getByTestId("declared-source-offer-decline")).toBeInTheDocument();
  });
});
