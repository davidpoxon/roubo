// @vitest-environment jsdom
//
// Container wiring for the Marketplaces settings section. MarketplacesTab exposes
// the Add and per-row Remove seams (issue #561); this container wires both.
//
// Add (CPHMTP-FR-002 / CPHMTP-US-001, issue #609): the Add control opens the
// registration consent dialog with an empty URL field, and a confirmed
// registration calls useRegisterMarketplaceSource and closes the dialog. These
// cover that Add opens the dialog empty, that confirming a typed URL calls the
// register mutation, that Cancel / Escape / a backdrop press register nothing and
// fetch nothing (CPHMTP-NFR-003), that a server refusal (400 invalid-url, 409
// already-registered) surfaces inline without dismissing the dialog or losing
// typed input, and that focus returns to the Add control on close (CPHMTP-NFR-008).
//
// Remove (CPHMTP-FR-009 / CPHMTP-US-006, issue #564): MarketplacesTab exposes the
// per-row Remove seam; this container wires it to the removal consequences dialog
// and drives DELETE /api/marketplace/sources/:id on confirm. These cover that
// Remove… opens the dialog (CPHMTP-TC-011 S002, CPHMTP-TC-012), that confirming
// calls the mutation with the source id and reports the client-derived orphaned
// count (CPHMTP-TC-011 S004), that Cancel mutates nothing (CPHMTP-TC-021), and
// that a failure surfaces inline.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { FIRST_PARTY_SOURCE_ID } from "@roubo/shared";
import type { MarketplaceSourceSummary, PluginRecord } from "@roubo/shared";
import { ApiError } from "../../../lib/api";
import { expectNoAxeFindings } from "../../../test/axe";

vi.mock("../../../hooks/useMarketplaceSources");
vi.mock("../../../hooks/useMarketplace");
vi.mock("../../../hooks/usePlugins");
vi.mock("../../../hooks/useToast");

import {
  useMarketplaceSources as _useSources,
  useRemoveMarketplaceSource as _useRemove,
} from "../../../hooks/useMarketplaceSources";
import { useRegisterMarketplaceSource as _useRegister } from "../../../hooks/useMarketplace";
import { usePlugins as _usePlugins } from "../../../hooks/usePlugins";
import { useToast as _useToast } from "../../../hooks/useToast";
import MarketplacesTabPanel from "./MarketplacesTabPanel";

const mockedSources = vi.mocked(_useSources);
const mockedRemove = vi.mocked(_useRemove);
const mockedRegister = vi.mocked(_useRegister);
const mockedPlugins = vi.mocked(_usePlugins);
const mockedToast = vi.mocked(_useToast);

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

const removeMutateAsync = vi.fn();
// register.mutate(vars, { onSuccess, onError }): the default implementation
// resolves through onSuccess. Error tests override it with mockImplementationOnce
// to fire onError instead.
const registerMutate =
  vi.fn<
    (
      vars: unknown,
      callbacks?: { onSuccess?: () => void; onError?: (err: unknown) => void },
    ) => void
  >();
const addToast = vi.fn();
// CPHMTP-NFR-003: the container must not reach the network on its own. The
// interceptor stands in for it so the "fetch nothing" criterion is asserted, not
// assumed (every data hook is mocked, so a real request would be a defect).
let fetchSpy: ReturnType<typeof vi.fn>;

function setRegister(isPending = false) {
  mockedRegister.mockReturnValue({
    mutate: registerMutate,
    isPending,
  } as unknown as ReturnType<typeof _useRegister>);
}

function setSources(sources: MarketplaceSourceSummary[]) {
  mockedSources.mockReturnValue({
    data: { sources },
    isLoading: false,
    error: null,
  } as unknown as ReturnType<typeof _useSources>);
}

function setPlugins(sourceIds: (string | undefined)[]) {
  const plugins = sourceIds.map((sourceId, i) => ({
    id: `plugin-${i}`,
    sourceId,
  })) as unknown as PluginRecord[];
  mockedPlugins.mockReturnValue({
    data: { hostApiVersion: "1.0.0", plugins },
  } as unknown as ReturnType<typeof _usePlugins>);
}

function setRemove(isPending = false) {
  mockedRemove.mockReturnValue({
    mutateAsync: removeMutateAsync,
    isPending,
  } as unknown as ReturnType<typeof _useRemove>);
}

beforeEach(() => {
  vi.clearAllMocks();
  removeMutateAsync.mockResolvedValue(undefined);
  // Default: a registration resolves. Callers that need a failure override with
  // registerMutate.mockImplementationOnce(...) before they render.
  registerMutate.mockImplementation((_vars, callbacks) => callbacks?.onSuccess?.());
  setSources([FIRST_PARTY, ACME]);
  setPlugins([ACME.id]); // one installed plugin from ACME
  setRegister();
  setRemove();
  mockedToast.mockReturnValue({ addToast, removeToast: vi.fn() });
  fetchSpy = vi.fn(() => Promise.reject(new Error("no request expected")));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function openRemoveDialog() {
  return userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Remove marketplace.acme.example…" }));
}

const CANDIDATE_URL = "https://marketplace.acme.example/catalog.json";

function ackCheckbox() {
  return within(screen.getByTestId("marketplace-source-consent-ack")).getByRole("checkbox");
}

// The ModalOverlay backdrop: the dialog's portalled outermost element, so it sits
// on baseElement rather than the render container.
function backdrop(baseElement: HTMLElement) {
  const el = baseElement.querySelector("[data-rac][class*='fixed inset-0']");
  if (!el) throw new Error("modal backdrop not found");
  return el as HTMLElement;
}

// CPHMTP-FR-002 / CPHMTP-US-001 (issue #609): the Add control mounts the shared
// consent dialog with an empty URL field the user types into.
describe("MarketplacesTabPanel: opening the add dialog (CPHMTP-FR-002)", () => {
  it("opens the consent dialog with an empty URL field when Add is pressed", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    expect(screen.queryByTestId("marketplace-source-consent-modal")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("add-marketplace"));

    expect(screen.getByTestId("marketplace-source-consent-modal")).toBeInTheDocument();
    expect(screen.getByLabelText("Marketplace URL")).toHaveValue("");
    // Nothing is registered or fetched just by opening the dialog.
    expect(registerMutate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// CPHMTP-FR-002: a confirmed registration hands the typed URL to
// useRegisterMarketplaceSource, which invalidates the settings list so the new
// row appears without a manual refresh, and the dialog closes.
describe("MarketplacesTabPanel: confirming a registration (CPHMTP-FR-002)", () => {
  it("registers the typed URL and closes the dialog on success", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await user.click(screen.getByTestId("add-marketplace"));

    await user.type(screen.getByLabelText("Marketplace URL"), CANDIDATE_URL);
    await user.click(ackCheckbox());
    await user.click(screen.getByTestId("marketplace-source-consent-confirm"));

    expect(registerMutate).toHaveBeenCalledTimes(1);
    expect(registerMutate).toHaveBeenCalledWith(
      expect.objectContaining({ url: CANDIDATE_URL, allowHttp: false }),
      expect.anything(),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("marketplace-source-consent-modal")).not.toBeInTheDocument(),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// CPHMTP-NFR-003: the three declining paths (Cancel, Escape, backdrop) close the
// dialog, register nothing, and fetch nothing.
describe("MarketplacesTabPanel: declining the add dialog (CPHMTP-NFR-003)", () => {
  async function openAdd(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByTestId("add-marketplace"));
    // Type and acknowledge so a decline is proven to abandon a would-be
    // registration, not just an untouched dialog.
    await user.type(screen.getByLabelText("Marketplace URL"), CANDIDATE_URL);
    await user.click(ackCheckbox());
  }

  it("registers and fetches nothing when Cancel is pressed", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openAdd(user);

    await user.click(screen.getByTestId("marketplace-source-consent-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("marketplace-source-consent-modal")).not.toBeInTheDocument(),
    );
    expect(registerMutate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers and fetches nothing when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openAdd(user);

    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByTestId("marketplace-source-consent-modal")).not.toBeInTheDocument(),
    );
    expect(registerMutate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("registers and fetches nothing when the backdrop is pressed", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<MarketplacesTabPanel />);
    await openAdd(user);

    await user.click(backdrop(baseElement));

    await waitFor(() =>
      expect(screen.queryByTestId("marketplace-source-consent-modal")).not.toBeInTheDocument(),
    );
    expect(registerMutate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// CPHMTP-FR-002 (criterion 4): a server refusal surfaces its message inline
// without dismissing the dialog or clearing the typed URL, so the operator can
// fix and retry.
describe("MarketplacesTabPanel: registration refused by the server", () => {
  it("surfaces a 400 invalid-url inline and keeps the dialog and typed input", async () => {
    registerMutate.mockImplementationOnce((_vars, callbacks) =>
      callbacks?.onError?.(new ApiError("Invalid source URL", 400)),
    );
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await user.click(screen.getByTestId("add-marketplace"));
    await user.type(screen.getByLabelText("Marketplace URL"), CANDIDATE_URL);
    await user.click(ackCheckbox());

    await user.click(screen.getByTestId("marketplace-source-consent-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("marketplace-source-consent-error")).toHaveTextContent(
        "Invalid source URL",
      ),
    );
    expect(screen.getByTestId("marketplace-source-consent-modal")).toBeInTheDocument();
    // Typed input is preserved (the modal owns the field state), so a retry does
    // not force a re-type.
    expect(screen.getByLabelText("Marketplace URL")).toHaveValue(CANDIDATE_URL);
  });

  it("surfaces a 409 already-registered inline and keeps the dialog open", async () => {
    registerMutate.mockImplementationOnce((_vars, callbacks) =>
      callbacks?.onError?.(new ApiError("Marketplace already registered", 409)),
    );
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await user.click(screen.getByTestId("add-marketplace"));
    await user.type(screen.getByLabelText("Marketplace URL"), CANDIDATE_URL);
    await user.click(ackCheckbox());

    await user.click(screen.getByTestId("marketplace-source-consent-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("marketplace-source-consent-error")).toHaveTextContent(
        "Marketplace already registered",
      ),
    );
    expect(screen.getByTestId("marketplace-source-consent-modal")).toBeInTheDocument();
  });
});

// CPHMTP-NFR-008 (criterion 5): closing the dialog returns focus to the Add
// control (React Aria's ModalOverlay restores focus to the pre-open trigger on
// unmount), and the mounted dialog scans clean under axe-core.
describe("MarketplacesTabPanel: add-dialog accessibility (CPHMTP-NFR-008)", () => {
  it("returns focus to the Add control when the dialog closes", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    const add = screen.getByTestId("add-marketplace");

    await user.click(add);
    expect(screen.getByTestId("marketplace-source-consent-modal")).toBeInTheDocument();
    await user.click(screen.getByTestId("marketplace-source-consent-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("marketplace-source-consent-modal")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it("has no axe findings with the add dialog open", async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<MarketplacesTabPanel />);
    await user.click(screen.getByTestId("add-marketplace"));
    expectNoAxeFindings(await axe(baseElement));
  });
});

describe("MarketplacesTabPanel: opening the dialog (CPHMTP-TC-011, CPHMTP-TC-012)", () => {
  it("opens the consequences dialog when a row's Remove… is pressed", async () => {
    render(<MarketplacesTabPanel />);
    expect(screen.queryByTestId("marketplace-source-remove-dialog")).not.toBeInTheDocument();

    await openRemoveDialog();

    const dialog = screen.getByTestId("marketplace-source-remove-dialog");
    expect(
      within(dialog).getByRole("heading", { name: 'Remove "marketplace.acme.example"?' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-source-remove-url")).toHaveTextContent(ACME.url);
    expect(screen.getByTestId("marketplace-source-remove-keep")).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-source-remove-orphan")).toBeInTheDocument();
    expect(screen.getByTestId("marketplace-source-remove-delete")).toBeInTheDocument();
  });
});

describe("MarketplacesTabPanel: confirming removal (CPHMTP-TC-011 S004)", () => {
  it("calls removeMarketplaceSource with the source id and reports the orphaned count", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-confirm"));

    await waitFor(() => expect(removeMutateAsync).toHaveBeenCalledWith(ACME.id));
    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Removed marketplace.acme.example; 1 plugin orphaned"),
    );
    // The dialog closes once removal succeeds.
    await waitFor(() =>
      expect(screen.queryByTestId("marketplace-source-remove-dialog")).not.toBeInTheDocument(),
    );
  });

  it("pluralises the orphaned count for more than one affected plugin", async () => {
    setPlugins([ACME.id, ACME.id, "other-source"]); // two from ACME, one elsewhere
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-confirm"));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Removed marketplace.acme.example; 2 plugins orphaned"),
    );
  });

  it("reports zero orphaned when the source has no installed plugins", async () => {
    setPlugins(["other-source"]);
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-confirm"));

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith("Removed marketplace.acme.example; 0 plugins orphaned"),
    );
  });
});

describe("MarketplacesTabPanel: cancelling (CPHMTP-TC-021)", () => {
  it("closes the dialog and mutates nothing when Cancel is pressed", async () => {
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("marketplace-source-remove-dialog")).not.toBeInTheDocument(),
    );
    expect(removeMutateAsync).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});

describe("MarketplacesTabPanel: failure", () => {
  it("surfaces a removal failure inline and keeps the dialog open", async () => {
    removeMutateAsync.mockRejectedValueOnce(new ApiError("Keyring is locked", 500));
    const user = userEvent.setup();
    render(<MarketplacesTabPanel />);
    await openRemoveDialog();

    await user.click(screen.getByTestId("marketplace-source-remove-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("marketplace-source-remove-error")).toHaveTextContent(
        "Keyring is locked",
      ),
    );
    expect(screen.getByTestId("marketplace-source-remove-dialog")).toBeInTheDocument();
    expect(addToast).not.toHaveBeenCalled();
  });
});
