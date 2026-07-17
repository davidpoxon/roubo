// @vitest-environment jsdom
//
// Registration consent for a third-party marketplace source (CPHMTP-FR-002 /
// CPHMTP-NFR-003, issue #562). The dialog is the only path to registering a
// source, so these cover what the consumer is shown before trusting a URL
// (CPHMTP-TC-005), the acknowledgement gate (CPHMTP-TC-020), that declining
// writes nothing (CPHMTP-TC-019), and that nothing is fetched while the dialog is
// open or on cancel (CPHMTP-TC-009).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MarketplaceSourceConsentModal from "./MarketplaceSourceConsentModal";

const CANDIDATE_URL = "https://marketplace.acme.example/catalog.json?ref=main";

// CPHMTP-NFR-003 / CPHMTP-TC-009: the interceptor stands in for the network. The
// dialog must not reach the candidate origin (or anywhere else) on its own; the
// single write lives in the container, behind onConfirm.
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("no request expected")));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderModal(over: Partial<Parameters<typeof MarketplaceSourceConsentModal>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const result = render(
    <MarketplaceSourceConsentModal
      initialUrl={CANDIDATE_URL}
      error={null}
      isPending={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, onCancel, ...result };
}

function ackCheckbox() {
  return within(screen.getByTestId("marketplace-source-consent-ack")).getByRole("checkbox");
}

function allowHttpCheckbox() {
  return within(screen.getByTestId("marketplace-source-consent-allow-http")).getByRole("checkbox");
}

function confirmButton() {
  return screen.getByTestId("marketplace-source-consent-confirm");
}

// The ModalOverlay backdrop: the dialog's portalled outermost element, so it sits
// on baseElement rather than the render container.
function backdrop(baseElement: HTMLElement) {
  const el = baseElement.querySelector("[data-rac][class*='fixed inset-0']");
  if (!el) throw new Error("modal backdrop not found");
  return el as HTMLElement;
}

// CPHMTP-TC-005: the consumer sees the exact string that will be fetched, plus
// the arbitrary-code / not-signed / permanently-Unverified warning.
describe("MarketplaceSourceConsentModal: raw URL and warning (CPHMTP-TC-005)", () => {
  it("titles the dialog as a third-party marketplace registration", () => {
    renderModal();
    expect(
      screen.getByRole("heading", { name: "Register a third-party marketplace" }),
    ).toBeTruthy();
  });

  it("shows the candidate URL verbatim, query string and all", () => {
    renderModal();
    // Not normalised, not truncated, not prettified: the raw string.
    expect(screen.getByLabelText("Marketplace URL")).toHaveValue(CANDIDATE_URL);
  });

  it("hints that the URL is shown exactly as it will be fetched", () => {
    renderModal();
    expect(
      screen.getByText(/shown exactly as it will be fetched/i, { exact: false }),
    ).toBeInTheDocument();
  });

  it("warns that the marketplace is unsigned and its plugins run with the user's privileges", () => {
    renderModal();
    const warning = screen.getByTestId("marketplace-source-consent-warning");
    expect(warning).toHaveTextContent(/not signed by roubo/i);
    expect(warning).toHaveTextContent(/run with your privileges/i);
    expect(warning).toHaveTextContent(/arbitrary code/i);
  });

  it("warns that installed plugins are permanently marked Unverified", () => {
    renderModal();
    expect(screen.getByTestId("marketplace-source-consent-warning")).toHaveTextContent(
      /permanently marked Unverified/i,
    );
  });

  it("restates the unsigned, arbitrary-code, and Unverified claims in the acknowledgement", () => {
    renderModal();
    const ack = screen.getByTestId("marketplace-source-consent-ack");
    expect(ack).toHaveTextContent(/not signed by roubo/i);
    expect(ack).toHaveTextContent(/arbitrary code/i);
    expect(ack).toHaveTextContent(/permanently marked Unverified/i);
  });
});

// CPHMTP-TC-020: the acknowledgement is the gate, and it is a gate in both
// directions. The control is aria-disabled rather than natively disabled, so the
// guarded onPress is what actually holds the line.
describe("MarketplaceSourceConsentModal: acknowledgement gate (CPHMTP-TC-020)", () => {
  it("gates Register while the acknowledgement is unchecked", () => {
    renderModal();
    expect(confirmButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("enables Register once the acknowledgement is checked", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(ackCheckbox());
    await waitFor(() => expect(confirmButton()).toHaveAttribute("aria-disabled", "false"));
  });

  it("re-gates Register when the acknowledgement is unchecked again", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(ackCheckbox());
    await waitFor(() => expect(confirmButton()).toHaveAttribute("aria-disabled", "false"));
    await user.click(ackCheckbox());
    await waitFor(() => expect(confirmButton()).toHaveAttribute("aria-disabled", "true"));
  });

  it("does not confirm when the gated Register control is pressed", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal();
    // aria-disabled leaves the control pressable, so the guard in handleConfirm
    // (not the DOM) is what must refuse.
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not confirm after the acknowledgement is unchecked again", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal();
    await user.click(ackCheckbox());
    await user.click(ackCheckbox());
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps Register gated when the URL field is empty, even once acknowledged", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal({ initialUrl: "" });
    await user.click(ackCheckbox());
    expect(confirmButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps Register gated when the URL field holds only whitespace", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal({ initialUrl: "   " });
    await user.click(ackCheckbox());
    expect(confirmButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("gates Register while a registration is already in flight", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal({ isPending: true });
    expect(confirmButton()).toHaveAttribute("aria-disabled", "true");
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// CPHMTP-FR-002 / CPHMTP-TC-104 S002: what an acknowledged registration hands the
// container. The consent record the container writes is built from exactly this.
describe("MarketplaceSourceConsentModal: confirm payload", () => {
  it("confirms with the acknowledged URL and http left off by default", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal();
    await user.click(ackCheckbox());
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({
      url: CANDIDATE_URL,
      credential: undefined,
      allowHttp: false,
    });
  });

  // The payload URL is the exact string the consent record is built from, so a
  // stray copy-paste space must not reach it verbatim.
  it("confirms with the URL trimmed, not as it was pasted", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal({ initialUrl: `  ${CANDIDATE_URL}  ` });
    await user.click(ackCheckbox());
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ url: CANDIDATE_URL }));
  });

  it("leaves the allow http (intranet) opt-in unchecked on open (Spike 551)", () => {
    renderModal();
    expect(allowHttpCheckbox()).not.toBeChecked();
  });

  it("carries the allow http (intranet) opt-in only when it is explicitly checked", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal({ initialUrl: "http://marketplace.intranet/catalog.json" });
    await user.click(allowHttpCheckbox());
    await user.click(ackCheckbox());
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ url: "http://marketplace.intranet/catalog.json", allowHttp: true }),
    );
  });

  it("carries the credential when one is typed", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal();
    await user.type(screen.getByLabelText("Credential (optional)"), "tok-abc");
    await user.click(ackCheckbox());
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ credential: "tok-abc" }));
  });

  it("masks the credential field so the token is not shown on screen", () => {
    renderModal();
    expect(screen.getByLabelText("Credential (optional)")).toHaveAttribute("type", "password");
  });

  it("confirms with an edited URL rather than the one it opened with", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal({ initialUrl: "" });
    await user.type(screen.getByLabelText("Marketplace URL"), "https://other.example/catalog.json");
    await user.click(ackCheckbox());
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://other.example/catalog.json" }),
    );
  });

  it("surfaces a registration failure in an alert region", () => {
    renderModal({ error: "Invalid source URL" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Invalid source URL");
  });
});

// CPHMTP-TC-019 / CPHMTP-TC-009: declining is inert. Nothing is registered, no
// consent record is asked for, and nothing is fetched.
describe("MarketplaceSourceConsentModal: declining (CPHMTP-TC-019)", () => {
  it("cancels without confirming when Cancel is pressed", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = renderModal();
    await user.click(screen.getByTestId("marketplace-source-consent-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels without confirming even after the acknowledgement was checked", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = renderModal();
    await user.click(ackCheckbox());
    await user.click(screen.getByTestId("marketplace-source-consent-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels on Escape", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = renderModal();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not cancel on Escape while a registration is in flight", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderModal({ isPending: true });
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  // The third declining path: pressing the backdrop. It routes through the same
  // onOpenChange -> handleCancel wiring as Cancel and Escape, isPending guard
  // included, so it is covered here rather than assumed from ModalOverlay.
  it("cancels on a backdrop press, registering and fetching nothing", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm, baseElement } = renderModal();
    await user.click(backdrop(baseElement));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not cancel on a backdrop press while a registration is in flight", async () => {
    const user = userEvent.setup();
    const { onCancel, baseElement } = renderModal({ isPending: true });
    await user.click(backdrop(baseElement));
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// CPHMTP-NFR-003 / CPHMTP-TC-009: consent precedes the first request. The dialog
// renders the candidate URL and never calls it.
describe("MarketplaceSourceConsentModal: consent before fetch (CPHMTP-TC-009)", () => {
  it("issues no request while the dialog is open and unconsented", async () => {
    const user = userEvent.setup();
    renderModal();
    // Everything short of confirming: read it, type a credential, tick the ack.
    await user.type(screen.getByLabelText("Credential (optional)"), "tok-abc");
    await user.click(ackCheckbox());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("issues no request on cancel", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(ackCheckbox());
    await user.click(screen.getByTestId("marketplace-source-consent-cancel"));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("issues no request of its own even on confirm: the container owns the write", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderModal();
    await user.click(ackCheckbox());
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
