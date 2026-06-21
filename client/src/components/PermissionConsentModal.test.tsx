// @vitest-environment jsdom
//
// Issue #615 (CP-FR-011 / CP-FR-012 / CP-NFR-007): the permission consent
// dialog must enumerate every declared category in plain language, label a
// non-first-party plugin unsandboxed, and gate the confirm control with
// aria-disabled (not the native disabled attribute) plus a guarded no-op
// onPress until the acknowledgement checkbox is ticked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginPermissions } from "@roubo/shared";
import PermissionConsentModal from "./PermissionConsentModal";

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

import { grantPluginConsent } from "../lib/api";

const mockedGrant = vi.mocked(grantPluginConsent);

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function permissions(overrides: Partial<PluginPermissions> = {}): PluginPermissions {
  return {
    network: { hosts: [] },
    credentials: { slots: [] },
    filesystem: { paths: [] },
    processes: false,
    ...overrides,
  } as PluginPermissions;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PermissionConsentModal", () => {
  it("renders every declared category in plain language", () => {
    const { getByTestId } = renderWithClient(
      <PermissionConsentModal
        pluginId="db-plugin"
        pluginName="Postgres"
        declared={permissions({
          network: { hosts: ["api.example.com"] },
          docker: {},
          ports: { names: ["pg"] },
        })}
        firstParty
        onCancel={() => {}}
        onConsented={() => {}}
      />,
    );
    const list = getByTestId("permission-consent-list");
    expect(list.querySelector('[data-category="network"]')).not.toBeNull();
    expect(list.querySelector('[data-category="ports"]')).not.toBeNull();
    expect(list.querySelector('[data-category="docker"]')).not.toBeNull();
    expect(within(list).getByText(/api\.example\.com/)).toBeInTheDocument();
    // A category that was not requested is not listed.
    expect(list.querySelector('[data-category="credentials"]')).toBeNull();
  });

  it("labels a non-first-party plugin unsandboxed", () => {
    const { getByTestId } = renderWithClient(
      <PermissionConsentModal
        pluginId="db-plugin"
        pluginName="Third Party"
        declared={permissions({ docker: {} })}
        firstParty={false}
        onCancel={() => {}}
        onConsented={() => {}}
      />,
    );
    const trust = getByTestId("permission-consent-trust");
    expect(trust.getAttribute("data-first-party")).toBe("false");
    expect(trust.textContent).toMatch(/unsandboxed/i);
    expect(trust.textContent).toMatch(/third-party/i);
  });

  it("keeps the confirm control focusable (aria-disabled, not native disabled) while gated", () => {
    const { getByTestId } = renderWithClient(
      <PermissionConsentModal
        pluginId="db-plugin"
        pluginName="Postgres"
        declared={permissions({ docker: {} })}
        firstParty
        onCancel={() => {}}
        onConsented={() => {}}
      />,
    );
    const confirm = getByTestId("permission-consent-confirm");
    // aria-disabled gate, never the native disabled attribute (NFR-007).
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm).not.toBeDisabled();
  });

  it("blocks consent until the acknowledgement is ticked, then submits", async () => {
    mockedGrant.mockResolvedValueOnce({
      pluginId: "db-plugin",
      acknowledgedCategories: ["docker"],
      consentedAt: "2026-06-21T00:00:00.000Z",
    });
    const onConsented = vi.fn();
    const user = userEvent.setup();
    const { getByTestId } = renderWithClient(
      <PermissionConsentModal
        pluginId="db-plugin"
        pluginName="Postgres"
        declared={permissions({ docker: {} })}
        firstParty
        onCancel={() => {}}
        onConsented={onConsented}
      />,
    );

    // Guarded no-op: pressing confirm before acknowledging does nothing.
    await user.click(getByTestId("permission-consent-confirm"));
    expect(mockedGrant).not.toHaveBeenCalled();
    expect(onConsented).not.toHaveBeenCalled();

    await user.click(getByTestId("permission-consent-ack"));
    expect(getByTestId("permission-consent-confirm").getAttribute("aria-disabled")).toBe("false");

    await user.click(getByTestId("permission-consent-confirm"));
    await waitFor(() => {
      expect(mockedGrant).toHaveBeenCalledWith("db-plugin", ["docker"]);
    });
    expect(onConsented).toHaveBeenCalled();
  });

  it("surfaces an inline error when consent fails", async () => {
    mockedGrant.mockRejectedValueOnce(new Error("consent store unavailable"));
    const user = userEvent.setup();
    const { getByTestId } = renderWithClient(
      <PermissionConsentModal
        pluginId="db-plugin"
        pluginName="Postgres"
        declared={permissions({ docker: {} })}
        firstParty
        onCancel={() => {}}
        onConsented={() => {}}
      />,
    );
    await user.click(getByTestId("permission-consent-ack"));
    await user.click(getByTestId("permission-consent-confirm"));
    await waitFor(() => {
      expect(getByTestId("permission-consent-error")).toHaveTextContent(
        /consent store unavailable/,
      );
    });
  });
});
