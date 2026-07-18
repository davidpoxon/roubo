// @vitest-environment jsdom
//
// CPHMTP-NFR-008 (WCAG 2.1 AA) / CPHMTP-TC-024, issue #562: the registration
// consent dialog is the only path to trusting a third-party marketplace, so it
// must be a properly announced modal that a keyboard-only consumer can read,
// gate, and decline. We scan the portalled dialog (render's `baseElement`, since
// ModalOverlay renders outside the container) and assert the modal semantics
// React Aria does not give us for free.

import { describe, it, expect, vi } from "vitest";
import { act, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { expectNoAxeFindings } from "../../test/axe";
import MarketplaceSourceConsentModal from "./MarketplaceSourceConsentModal";

const CANDIDATE_URL = "https://marketplace.acme.example/catalog.json";

function renderModal(over: Partial<Parameters<typeof MarketplaceSourceConsentModal>[0]> = {}) {
  return render(
    <MarketplaceSourceConsentModal
      initialUrl={CANDIDATE_URL}
      error={null}
      isPending={false}
      onCancel={() => {}}
      onConfirm={() => {}}
      {...over}
    />,
  );
}

describe("MarketplaceSourceConsentModal: axe-core (CPHMTP-NFR-008, CPHMTP-TC-024)", () => {
  it("has no axe violations in the gated dialog", async () => {
    const { baseElement } = renderModal();
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("has no axe violations with a registration error shown", async () => {
    const { baseElement } = renderModal({ error: "Invalid source URL" });
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });

  it("has no axe violations while a registration is in flight", async () => {
    const { baseElement } = renderModal({ isPending: true });
    const results = await axe(baseElement);
    expectNoAxeFindings(results);
  });
});

describe("MarketplaceSourceConsentModal: modal semantics (CPHMTP-TC-024 S001)", () => {
  it("exposes role=dialog with aria-modal and a title reference", () => {
    const { getByRole } = renderModal();
    const dialog = getByRole("dialog");
    // React Aria omits aria-modal deliberately and strips the prop, so this only
    // holds because the component stamps it through a ref via the shared
    // stampAriaModal helper (issue #424).
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)).toHaveTextContent(
      "Register a third-party marketplace",
    );
  });

  it("focuses Cancel on open, so declining is the default answer", async () => {
    const { getByTestId } = renderModal();
    await waitFor(() => expect(getByTestId("marketplace-source-consent-cancel")).toHaveFocus());
  });

  it("focuses the URL field on open when the consumer has to supply the URL", async () => {
    const { getByLabelText } = renderModal({ initialUrl: "" });
    await waitFor(() => expect(getByLabelText("Marketplace URL")).toHaveFocus());
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderModal({ onCancel });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});

describe("MarketplaceSourceConsentModal: keyboard operation (CPHMTP-TC-024 S002)", () => {
  it("labels every control the consumer must read or set", () => {
    const { getByLabelText, getByTestId } = renderModal();
    expect(getByLabelText("Marketplace URL")).toBeInTheDocument();
    expect(getByLabelText("Credential (optional)")).toBeInTheDocument();
    expect(
      within(getByTestId("marketplace-source-consent-allow-http")).getByRole("checkbox"),
    ).toBeInTheDocument();
    expect(
      within(getByTestId("marketplace-source-consent-ack")).getByRole("checkbox"),
    ).toBeInTheDocument();
    expect(getByTestId("marketplace-source-consent-cancel")).toBeInTheDocument();
    expect(getByTestId("marketplace-source-consent-confirm")).toBeInTheDocument();
  });

  // Each hint carries something the label does not say: that the URL is the exact
  // string that will be fetched, where the credential is stored, and that plain
  // http is readable and tamperable on the network. A hint that is merely adjacent
  // in the DOM is never announced on focus, and axe has no rule for it, so the
  // association is asserted directly (CPHMTP-NFR-008).
  it("describes the URL, credential, and allow-http controls, not just labels them", () => {
    const { getByLabelText, getByTestId } = renderModal();

    function describedText(el: Element): string {
      const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    }

    expect(describedText(getByLabelText("Marketplace URL"))).toMatch(
      /shown exactly as it will be fetched/i,
    );
    expect(describedText(getByLabelText("Credential (optional)"))).toMatch(/OS keyring/i);
    expect(
      describedText(
        within(getByTestId("marketplace-source-consent-allow-http")).getByRole("checkbox"),
      ),
    ).toMatch(/read and tamper with/i);
  });

  it("keeps the gated Register control focusable and toggles it from the keyboard alone", async () => {
    const user = userEvent.setup();
    const { getByTestId } = renderModal();

    // aria-disabled, not native disabled: gated but still reachable (NFR-008).
    // React Aria updates focus state on focus, so drive the bare focus() calls
    // through act(): unwrapped they warn on stderr.
    const confirm = getByTestId("marketplace-source-consent-confirm");
    act(() => confirm.focus());
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAttribute("aria-disabled", "true");

    const ack = within(getByTestId("marketplace-source-consent-ack")).getByRole("checkbox");
    act(() => ack.focus());
    await user.keyboard(" ");
    await waitFor(() => expect(confirm).toHaveAttribute("aria-disabled", "false"));

    await user.keyboard(" ");
    await waitFor(() => expect(confirm).toHaveAttribute("aria-disabled", "true"));
  });

  it("traps focus inside the dialog", async () => {
    const user = userEvent.setup();
    const { getByRole } = renderModal();
    const dialog = getByRole("dialog");
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });
});
