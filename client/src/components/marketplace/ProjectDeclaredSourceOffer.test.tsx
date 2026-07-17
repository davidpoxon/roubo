// @vitest-environment jsdom
//
// Project-open registration offer for declared-but-unregistered marketplaces
// (CPHMTP-FR-007 / CPHMTP-NFR-003 / CPHMTP-US-002, issue #565). These cover the
// offer banner and its copy (CPHMTP-TC-074), that opening or ignoring the project
// fetches nothing from the declared URL (CPHMTP-TC-075), routing through the
// consent gate with the raw URL prefilled and decline as the default
// (CPHMTP-TC-076), session-scoped decline suppression across navigation
// (CPHMTP-TC-078), no offer for an already-registered source (CPHMTP-TC-079) or a
// casing/trailing-slash variant of one (CPHMTP-TC-080), offering only the
// unregistered source when several are declared (CPHMTP-TC-085), the recorded
// registration payload (CPHMTP-TC-086), and re-offer in a fresh session
// (CPHMTP-TC-087).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary, RegisteredProject } from "@roubo/shared";

vi.mock("../../hooks/useMarketplaceSources");
vi.mock("../../hooks/useMarketplace");

const toastHooks = vi.hoisted(() => ({ addToast: vi.fn() }));
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ addToast: toastHooks.addToast }),
}));

import { useMarketplaceSources as _useSources } from "../../hooks/useMarketplaceSources";
import { useRegisterMarketplaceSource as _useRegister } from "../../hooks/useMarketplace";
import { DeclinedSourceOffersProvider } from "../DeclinedSourceOffersProvider";
import ProjectDeclaredSourceOffer from "./ProjectDeclaredSourceOffer";

const mockedSources = vi.mocked(_useSources);
const mockedRegister = vi.mocked(_useRegister);

const DECLARED_URL = "https://marketplace.acme.example/catalog.json";
const REGISTERED_URL = "https://plugins.other.example/catalog.json";
const FIRST_PARTY_URL = "https://davidpoxon.github.io/roubo-plugins/catalog.json";

let registerMutate: ReturnType<typeof vi.fn>;
let fetchSpy: ReturnType<typeof vi.fn>;

function summary(url: string, id = `src-${url}`): MarketplaceSourceSummary {
  return { id, url, hasCredential: false, registeredAt: "2026-01-01T00:00:00.000Z" };
}

const FIRST_PARTY_SUMMARY: MarketplaceSourceSummary = {
  id: FIRST_PARTY_SOURCE_ID,
  url: FIRST_PARTY_URL,
  hasCredential: false,
  registeredAt: "1970-01-01T00:00:00.000Z",
};

function setSources(sources: MarketplaceSourceSummary[]) {
  mockedSources.mockReturnValue({ data: { sources } } as unknown as ReturnType<typeof _useSources>);
}

function makeProject(
  marketplaces: { url: string }[],
  displayName = "acme-webapp",
): RegisteredProject {
  return {
    id: "acme-webapp",
    repoPath: "/repo/acme-webapp",
    configValid: true,
    settings: {} as RegisteredProject["settings"],
    config: { project: { displayName }, marketplaces },
  } as unknown as RegisteredProject;
}

function renderOffer(project: RegisteredProject | undefined, projectId = "acme-webapp") {
  return render(
    <DeclinedSourceOffersProvider>
      <ProjectDeclaredSourceOffer projectId={projectId} project={project} />
    </DeclinedSourceOffersProvider>,
  );
}

beforeEach(() => {
  registerMutate = vi.fn();
  mockedRegister.mockReturnValue({
    mutate: registerMutate,
    isPending: false,
  } as unknown as ReturnType<typeof _useRegister>);
  // Default: only the built-in first-party source is registered.
  setSources([FIRST_PARTY_SUMMARY]);
  toastHooks.addToast.mockClear();
  // The interceptor stands in for the network: opening or ignoring a project must
  // never reach the declared origin (CPHMTP-NFR-003).
  fetchSpy = vi.fn(() => Promise.reject(new Error("no request expected")));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// CPHMTP-TC-074: the offer banner names the project, shows the raw declared URL,
// explains what registering enables, and offers both actions.
describe("ProjectDeclaredSourceOffer: offer banner (CPHMTP-TC-074)", () => {
  it("shows a banner naming the project and the exact declared URL", () => {
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    const banner = screen.getByTestId("declared-source-offer");
    expect(banner).toHaveTextContent("acme-webapp");
    expect(banner).toHaveTextContent(DECLARED_URL);
  });

  it("offers Review-and-register and Not-now actions", () => {
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    expect(screen.getByTestId("declared-source-offer-review")).toHaveTextContent(
      /review and register/i,
    );
    expect(screen.getByTestId("declared-source-offer-decline")).toHaveTextContent(/not now/i);
  });

  it("states that registering lets the project's benches install the plugins it offers", () => {
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    const banner = screen.getByTestId("declared-source-offer");
    expect(banner).toHaveTextContent(/benches/i);
    expect(banner).toHaveTextContent(/install the plugins/i);
  });

  it("states that Roubo will not contact the URL unless the user registers it", () => {
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    const banner = screen.getByTestId("declared-source-offer");
    expect(banner).toHaveTextContent(/will not contact this marketplace until you register/i);
  });
});

// CPHMTP-TC-075: opening the project puts the offer between the user and any
// fetch; the declared origin is never contacted, and ignoring the project cannot
// trigger one either.
describe("ProjectDeclaredSourceOffer: no fetch before consent (CPHMTP-TC-075)", () => {
  it("renders the offer without contacting the declared origin", () => {
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    expect(screen.getByTestId("declared-source-offer")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("makes no request and registers nothing when the offer is left unactioned and unmounted", () => {
    const { unmount } = renderOffer(makeProject([{ url: DECLARED_URL }]));
    // Navigate away without consenting.
    unmount();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(registerMutate).not.toHaveBeenCalled();
  });
});

// CPHMTP-TC-076: Review-and-register opens the shared consent dialog with the raw
// URL prefilled, Register gated (decline default), and nothing fetched until the
// acknowledged Register press hands the write to the register mutation.
describe("ProjectDeclaredSourceOffer: routes through the consent gate (CPHMTP-TC-076)", () => {
  it("opens the consent dialog with the raw declared URL prefilled and Register gated", async () => {
    const user = userEvent.setup();
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    await user.click(screen.getByTestId("declared-source-offer-review"));

    expect(screen.getByTestId("marketplace-source-consent-modal")).toBeInTheDocument();
    expect(screen.getByLabelText("Marketplace URL")).toHaveValue(DECLARED_URL);
    // Decline is the default: Register is gated until the warning is acknowledged.
    expect(screen.getByTestId("marketplace-source-consent-confirm")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByTestId("marketplace-source-consent-warning")).toHaveTextContent(
      /not signed by roubo/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(registerMutate).not.toHaveBeenCalled();
  });

  it("registers the declared URL only after the warning is acknowledged and Register pressed", async () => {
    const user = userEvent.setup();
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    await user.click(screen.getByTestId("declared-source-offer-review"));

    await user.click(
      within(screen.getByTestId("marketplace-source-consent-ack")).getByRole("checkbox"),
    );
    await user.click(screen.getByTestId("marketplace-source-consent-confirm"));

    expect(registerMutate).toHaveBeenCalledTimes(1);
    expect(registerMutate).toHaveBeenCalledWith(
      expect.objectContaining({ url: DECLARED_URL, allowHttp: false }),
      expect.anything(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// CPHMTP-TC-078: declining suppresses the offer for the rest of the session,
// including after navigating away from the project and back.
describe("ProjectDeclaredSourceOffer: session-scoped decline (CPHMTP-TC-078)", () => {
  function Harness({ show, project }: { show: boolean; project: RegisteredProject }) {
    return (
      <DeclinedSourceOffersProvider>
        {show && <ProjectDeclaredSourceOffer projectId="acme-webapp" project={project} />}
      </DeclinedSourceOffersProvider>
    );
  }

  it("dismisses the banner and notes the session decline on Not now", async () => {
    const user = userEvent.setup();
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    await user.click(screen.getByTestId("declared-source-offer-decline"));

    expect(screen.queryByTestId("declared-source-offer")).not.toBeInTheDocument();
    expect(toastHooks.addToast).toHaveBeenCalledWith(
      expect.stringMatching(/declined for this session/i),
    );
    expect(registerMutate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not re-offer after navigating away from the project and back in the same session", async () => {
    const user = userEvent.setup();
    const project = makeProject([{ url: DECLARED_URL }]);
    const { rerender } = render(<Harness show project={project} />);

    await user.click(screen.getByTestId("declared-source-offer-decline"));
    // Navigate away: the offer unmounts, but the provider (session memory) stays.
    rerender(<Harness show={false} project={project} />);
    // Navigate back: the offer remounts under the same provider.
    rerender(<Harness show project={project} />);

    expect(screen.queryByTestId("declared-source-offer")).not.toBeInTheDocument();
  });
});

// CPHMTP-TC-079 / CPHMTP-TC-080: a declared URL that matches a registered source,
// including a casing/trailing-slash variant, shows no offer and creates no
// duplicate.
describe("ProjectDeclaredSourceOffer: already-registered sources (CPHMTP-TC-079, CPHMTP-TC-080)", () => {
  it("shows no offer when the declared URL is already registered (CPHMTP-TC-079)", () => {
    setSources([FIRST_PARTY_SUMMARY, summary(DECLARED_URL)]);
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    expect(screen.queryByTestId("declared-source-offer")).not.toBeInTheDocument();
  });

  it("treats a casing/trailing-slash variant as the same source (CPHMTP-TC-080)", () => {
    // Registered under its canonical origin href; declared with an uppercased
    // scheme/host and no trailing slash. Both normalise to the same href.
    setSources([FIRST_PARTY_SUMMARY, summary("https://marketplace.acme.example/")]);
    renderOffer(makeProject([{ url: "HTTPS://MARKETPLACE.ACME.EXAMPLE" }]));
    expect(screen.queryByTestId("declared-source-offer")).not.toBeInTheDocument();
  });

  it("does not offer the built-in first-party catalog even though it is skipped from the registered set", () => {
    // The first-party row is excluded from the comparison set; a project that
    // declares some other URL is unaffected by that exclusion.
    setSources([FIRST_PARTY_SUMMARY, summary(DECLARED_URL)]);
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    expect(screen.queryByTestId("declared-source-offer")).not.toBeInTheDocument();
  });
});

// CPHMTP-TC-085: a project declaring several marketplaces offers only the
// unregistered ones.
describe("ProjectDeclaredSourceOffer: multiple declarations (CPHMTP-TC-085)", () => {
  it("offers only the unregistered declared source", () => {
    setSources([FIRST_PARTY_SUMMARY, summary(REGISTERED_URL)]);
    renderOffer(makeProject([{ url: REGISTERED_URL }, { url: DECLARED_URL }]));

    const banners = screen.getAllByTestId("declared-source-offer");
    expect(banners).toHaveLength(1);
    expect(banners[0]).toHaveAttribute("data-declared-url", DECLARED_URL);
    expect(banners[0]).not.toHaveTextContent(REGISTERED_URL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("de-duplicates two spellings of the same unregistered source into one offer", () => {
    renderOffer(
      makeProject([
        { url: DECLARED_URL },
        { url: "HTTPS://MARKETPLACE.ACME.EXAMPLE/catalog.json" },
      ]),
    );
    expect(screen.getAllByTestId("declared-source-offer")).toHaveLength(1);
  });
});

// CPHMTP-TC-086: consenting records the exact declared URL. The unsigned status
// and registration timestamp are stamped server-side by the register endpoint
// (issue #562); the client contributes the URL the consent record is keyed on.
describe("ProjectDeclaredSourceOffer: recorded registration (CPHMTP-TC-086)", () => {
  it("hands the exact declared URL to the register mutation on consent", async () => {
    const user = userEvent.setup();
    renderOffer(makeProject([{ url: DECLARED_URL }]));
    await user.click(screen.getByTestId("declared-source-offer-review"));
    await user.click(
      within(screen.getByTestId("marketplace-source-consent-ack")).getByRole("checkbox"),
    );
    await user.click(screen.getByTestId("marketplace-source-consent-confirm"));

    expect(registerMutate).toHaveBeenCalledWith(
      expect.objectContaining({ url: DECLARED_URL }),
      expect.anything(),
    );
  });
});

// CPHMTP-TC-087: a decline is session-scoped, so a fresh session (a new provider)
// re-presents the offer.
describe("ProjectDeclaredSourceOffer: re-offer in a new session (CPHMTP-TC-087)", () => {
  it("re-presents the offer under a fresh provider after a prior-session decline", async () => {
    const user = userEvent.setup();
    const project = makeProject([{ url: DECLARED_URL }]);

    // Session one: decline, offer suppressed.
    const first = renderOffer(project);
    await user.click(screen.getByTestId("declared-source-offer-decline"));
    expect(screen.queryByTestId("declared-source-offer")).not.toBeInTheDocument();
    first.unmount();

    // Session two: a brand-new provider re-presents the offer.
    renderOffer(project);
    expect(screen.getByTestId("declared-source-offer")).toBeInTheDocument();
    expect(registerMutate).not.toHaveBeenCalled();
  });
});
