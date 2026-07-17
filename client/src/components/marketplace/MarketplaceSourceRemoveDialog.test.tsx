// @vitest-environment jsdom
//
// Removal consequences dialog for a third-party marketplace source
// (CPHMTP-FR-009 / CPHMTP-US-006, issue #564). These cover what the operator is
// shown before confirming a removal (CPHMTP-TC-011 S002-S003, CPHMTP-TC-012), that
// the destructive action never opens focused (CPHMTP-TC-012 S001-O02), that
// declining (Cancel, Escape, backdrop) fires no confirmation (CPHMTP-TC-021), and
// that confirming hands the container the go-ahead (CPHMTP-TC-011 S004).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MarketplaceSourceRemoveDialog from "./MarketplaceSourceRemoveDialog";

const SOURCE_NAME = "marketplace.acme.example";
const SOURCE_URL = "https://marketplace.acme.example/catalog.json";

// The dialog owns no network of its own: the container drives DELETE behind
// onConfirm. Standing in for fetch proves the presentational dialog stays inert.
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(() => Promise.reject(new Error("no request expected")));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDialog(over: Partial<Parameters<typeof MarketplaceSourceRemoveDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const result = render(
    <MarketplaceSourceRemoveDialog
      sourceName={SOURCE_NAME}
      sourceUrl={SOURCE_URL}
      error={null}
      isPending={false}
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...over}
    />,
  );
  return { onConfirm, onCancel, ...result };
}

function cancelButton() {
  return screen.getByTestId("marketplace-source-remove-cancel");
}

function confirmButton() {
  return screen.getByTestId("marketplace-source-remove-confirm");
}

// The ModalOverlay backdrop: the portalled outermost element, on baseElement.
function backdrop(baseElement: HTMLElement) {
  const el = baseElement.querySelector("[data-rac][class*='fixed inset-0']");
  if (!el) throw new Error("modal backdrop not found");
  return el as HTMLElement;
}

// CPHMTP-TC-011 S002-O01: the dialog is titled Remove "<source>"? and shows the URL.
describe("MarketplaceSourceRemoveDialog: title and URL (CPHMTP-TC-011)", () => {
  it("titles the dialog with the source name", () => {
    renderDialog();
    expect(screen.getByRole("heading", { name: `Remove "${SOURCE_NAME}"?` })).toBeInTheDocument();
  });

  it("shows the source URL verbatim", () => {
    renderDialog();
    expect(screen.getByTestId("marketplace-source-remove-url")).toHaveTextContent(SOURCE_URL);
  });
});

// CPHMTP-TC-011 S003 / CPHMTP-TC-012 S001-O01: the three consequence rows.
describe("MarketplaceSourceRemoveDialog: consequence rows (CPHMTP-TC-011, CPHMTP-TC-012)", () => {
  it("renders a keep row: plugins stay installed and keep running", () => {
    renderDialog();
    const keep = screen.getByTestId("marketplace-source-remove-keep");
    expect(keep).toHaveTextContent(/stays installed and keeps running/i);
  });

  it("renders an orphan-warn row: marked orphaned, no updates until re-registered", () => {
    renderDialog();
    const orphan = screen.getByTestId("marketplace-source-remove-orphan");
    expect(orphan).toHaveTextContent(/orphaned/i);
    expect(orphan).toHaveTextContent(/no updates until you re-register/i);
  });

  it("renders a delete row: registry entry, cached catalog, and stored credential deleted", () => {
    renderDialog();
    const del = screen.getByTestId("marketplace-source-remove-delete");
    expect(del).toHaveTextContent(/registry entry/i);
    expect(del).toHaveTextContent(/cached catalog/i);
    expect(del).toHaveTextContent(/stored credential/i);
    expect(del).toHaveTextContent(/deleted/i);
  });
});

// CPHMTP-TC-012 S001-O02: both actions are present and the safe answer is the
// default (no destructive action pre-selected).
describe("MarketplaceSourceRemoveDialog: actions default to safe (CPHMTP-TC-012)", () => {
  it("presents both a Cancel and a 'Remove marketplace' action", () => {
    renderDialog();
    expect(cancelButton()).toHaveTextContent("Cancel");
    expect(confirmButton()).toHaveTextContent("Remove marketplace");
  });

  it("focuses Cancel on open, never the destructive Remove control", async () => {
    renderDialog();
    await waitFor(() => expect(cancelButton()).toHaveFocus());
    expect(confirmButton()).not.toHaveFocus();
  });
});

// CPHMTP-TC-011 S004: confirming hands the container the go-ahead.
describe("MarketplaceSourceRemoveDialog: confirm (CPHMTP-TC-011)", () => {
  it("fires onConfirm when 'Remove marketplace' is pressed", async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderDialog();
    await user.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not fire onConfirm again while a removal is in flight", async () => {
    const user = userEvent.setup();
    const { onConfirm } = renderDialog({ isPending: true });
    expect(confirmButton()).toHaveTextContent("Removing…");
    await user.click(confirmButton());
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

// CPHMTP-TC-021: declining leaves everything intact (the dialog fires no
// confirmation on Cancel, Escape, or a backdrop press).
describe("MarketplaceSourceRemoveDialog: declining (CPHMTP-TC-021)", () => {
  it("cancels without confirming when Cancel is pressed", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = renderDialog();
    await user.click(cancelButton());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels on Escape without confirming", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm } = renderDialog();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("cancels on a backdrop press without confirming", async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm, baseElement } = renderDialog();
    await user.click(backdrop(baseElement));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("does not cancel on Escape while a removal is in flight", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ isPending: true });
    await user.keyboard("{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("does not cancel when Cancel is pressed while a removal is in flight", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog({ isPending: true });
    await user.click(cancelButton());
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe("MarketplaceSourceRemoveDialog: error surfacing", () => {
  it("surfaces a removal failure in an alert region", () => {
    renderDialog({ error: "Keyring is locked" });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Keyring is locked");
  });
});
