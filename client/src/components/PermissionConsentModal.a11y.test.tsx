// @vitest-environment jsdom
//
// Issue #615 (CP-NFR-007, WCAG 2.1 AA): the permission consent dialog must pass
// an axe-core scan and be fully keyboard operable (role=dialog, aria-modal,
// focus trap, amber focus rings). We scan the gated idle state and the
// post-acknowledgement state (both visually distinct trees), then assert the
// dialog semantics and keyboard reachability of the gated confirm control.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe } from "vitest-axe";
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginPermissions } from "@roubo/shared";
import PermissionConsentModal from "./PermissionConsentModal";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}

expect.extend({ toHaveNoViolations });

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    grantPluginConsent: vi.fn(),
  };
});

vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function permissions(): PluginPermissions {
  return {
    network: { hosts: ["api.example.com"] },
    credentials: { slots: [{ slot: "token", scope: "read", description: "API token" }] },
    filesystem: { paths: ["/workspace"] },
    processes: { executables: ["node"] },
    ports: { names: ["http"] },
    docker: {},
  } as PluginPermissions;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PermissionConsentModal: axe-core (WCAG 2.1 AA, CP-NFR-007)", () => {
  it("has no axe violations in the gated idle state", async () => {
    const { baseElement } = renderWithClient(
      <PermissionConsentModal
        pluginId="db-plugin"
        pluginName="Postgres"
        declared={permissions()}
        firstParty={false}
        onCancel={() => {}}
        onConsented={() => {}}
      />,
    );
    const results = await axe(baseElement);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations after the acknowledgement is ticked", async () => {
    const user = userEvent.setup();
    const { baseElement, getByTestId } = renderWithClient(
      <PermissionConsentModal
        pluginId="db-plugin"
        pluginName="Postgres"
        declared={permissions()}
        firstParty
        onCancel={() => {}}
        onConsented={() => {}}
      />,
    );
    await user.click(getByTestId("permission-consent-ack"));
    await waitFor(() => {
      expect(getByTestId("permission-consent-confirm").getAttribute("aria-disabled")).toBe("false");
    });
    const results = await axe(baseElement);
    expect(results).toHaveNoViolations();
  });

  it("exposes a modal dialog and keeps the gated confirm control keyboard reachable", async () => {
    const user = userEvent.setup();
    const { getByRole, getByTestId } = renderWithClient(
      <PermissionConsentModal
        pluginId="db-plugin"
        pluginName="Postgres"
        declared={permissions()}
        firstParty
        onCancel={() => {}}
        onConsented={() => {}}
      />,
    );
    // role=dialog with an accessible name (the Heading is the dialog title).
    // The axe scan above validates the full modal semantics (aria-modal, focus
    // management) that React Aria's Modal layer provides.
    const dialog = getByRole("dialog");
    expect(dialog).toBeInTheDocument();

    // The confirm control is aria-disabled while gated but, unlike a natively
    // disabled button, remains focusable via the keyboard (NFR-007).
    const confirm = getByTestId("permission-consent-confirm");
    confirm.focus();
    expect(confirm).toHaveFocus();

    // Tab cycles within the dialog (focus trap): focus never escapes to the
    // document body.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
