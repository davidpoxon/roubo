// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  GlobalPluginIntegrationState,
  IntegrationConfig,
  PluginManifest,
  PluginRecord,
  PluginStatus,
} from "@roubo/shared";

vi.mock("../../../hooks/usePlugins");
vi.mock("../../../hooks/useGlobalPluginIntegration", () => ({
  useGlobalPluginIntegration: vi.fn(),
  // PluginConfigureDialog (rendered by DialogTrigger when integration data is
  // present) also imports these. We don't exercise them here; stub-and-forget.
  useTestGlobalPluginIntegration: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    reset: vi.fn(),
  }),
  useSaveGlobalPluginIntegration: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    reset: vi.fn(),
  }),
}));
// ErroredBanner (rendered by PluginCard on errored status, issue #496) calls
// these marketplace mutation hooks and useToast unconditionally to drive its
// Reinstall affordance. Stub them so the errored-status renders need no
// QueryClientProvider / ToastProvider; these tests assert the banner renders,
// not the reinstall flow (that has its own coverage in ErroredBanner.test.tsx).
// Stub-and-forget.
vi.mock("../../../hooks/useMarketplace", () => ({
  useMarketplaceUpdatePreview: () => ({ mutate: vi.fn(), isPending: false }),
  useMarketplaceInstallConfirm: () => ({ mutate: vi.fn(), isPending: false }),
  useMarketplaceInstallCancel: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));
import {
  useConnectionStatus as _useConnectionStatus,
  useConsentStatus as _useConsentStatus,
  useDisablePlugin as _useDisable,
  useEnablePlugin as _useEnable,
  useGrantConsent as _useGrantConsent,
  useRestartPlugin as _useRestart,
  useUninstallPlugin as _useUninstall,
  usePluginLogs as _usePluginLogs,
} from "../../../hooks/usePlugins";
import { useGlobalPluginIntegration as _useGlobalIntegration } from "../../../hooks/useGlobalPluginIntegration";
import PluginCard from "./PluginCard";

const mockedEnable = vi.mocked(_useEnable);
const mockedDisable = vi.mocked(_useDisable);
const mockedRestart = vi.mocked(_useRestart);
const mockedUninstall = vi.mocked(_useUninstall);
const mockedLogs = vi.mocked(_usePluginLogs);
const mockedGlobalIntegration = vi.mocked(_useGlobalIntegration);
const mockedConnectionStatus = vi.mocked(_useConnectionStatus);
const mockedConsentStatus = vi.mocked(_useConsentStatus);
const mockedGrantConsent = vi.mocked(_useGrantConsent);

function manifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "github-com",
    name: "GitHub.com",
    version: "1.2.3",
    description: "Pulls issues from GitHub.com",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "dist/index.js",
    permissions: {
      network: { hosts: ["api.github.com"] },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: false,
    },
    ...over,
  };
}

function record(over: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "github-com",
    manifest: manifest(),
    manifestPath: "/p/github-com/roubo-plugin.yaml",
    pluginDir: "/p/github-com",
    source: "bundled",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 1234,
    ...over,
  };
}

function integrationState(effective: IntegrationConfig = {}): GlobalPluginIntegrationState {
  return {
    effective,
    plugin: {
      id: "github-com",
      installed: true,
      status: "enabled",
      manifest: { name: "GitHub.com" },
    },
  };
}

beforeEach(() => {
  mockedEnable.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof _useEnable>);
  mockedDisable.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof _useDisable>);
  mockedRestart.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof _useRestart>);
  mockedUninstall.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof _useUninstall>);
  mockedLogs.mockReturnValue({
    data: { lines: [] },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof _usePluginLogs>);
  mockedGlobalIntegration.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof _useGlobalIntegration>);
  mockedConnectionStatus.mockReturnValue({
    data: undefined,
    isFetching: false,
  } as unknown as ReturnType<typeof _useConnectionStatus>);
  // Integration cards never fetch consent (the query is gated to component
  // cards), so the default is a no-data query. Component tests override this.
  mockedConsentStatus.mockReturnValue({
    data: undefined,
  } as unknown as ReturnType<typeof _useConsentStatus>);
  mockedGrantConsent.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof _useGrantConsent>);
});

function componentManifest(over: Partial<PluginManifest> = {}): PluginManifest {
  return manifest({
    id: "database",
    name: "Database",
    kind: "component",
    permissions: {
      network: { hosts: [] },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: false,
      docker: {},
    },
    ...over,
  });
}

function componentRecord(over: Partial<PluginRecord> = {}): PluginRecord {
  return record({ id: "database", source: "bundled", manifest: componentManifest(), ...over });
}

describe("PluginCard: header content (TC-001, TC-013, FR-057)", () => {
  it("renders name, version, source label, and description", () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByText("GitHub.com")).toBeTruthy();
    expect(screen.getByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("Pulls issues from GitHub.com")).toBeTruthy();
    expect(screen.getByTestId("plugin-source-label").dataset.source).toBe("bundled");
  });

  it("falls back to the plugin id when no manifest is present", () => {
    render(
      <PluginCard
        plugin={record({ manifest: null, status: "invalid" as PluginStatus })}
        hostApiVersion="1.0.0"
      />,
    );
    expect(screen.getByText("github-com")).toBeTruthy();
  });
});

describe("PluginCard: plugin icon (FR-057, mockups §22)", () => {
  it("renders the manifest icon as an image when it is a data: URI", () => {
    const iconUri = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>";
    render(
      <PluginCard
        plugin={record({ manifest: manifest({ icon: iconUri }) })}
        hostApiVersion="1.0.0"
      />,
    );
    const icon = screen.getByTestId("plugin-icon") as HTMLImageElement;
    expect(icon.getAttribute("src")).toBe(iconUri);
    expect(icon.width).toBe(32);
    expect(icon.height).toBe(32);
  });

  it("renders a fallback icon when the manifest has no icon", () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByTestId("plugin-icon-fallback")).toBeTruthy();
  });

  it("renders a fallback when the manifest icon is a non-data path (not yet served)", () => {
    render(
      <PluginCard
        plugin={record({ manifest: manifest({ icon: "assets/icon.svg" }) })}
        hostApiVersion="1.0.0"
      />,
    );
    expect(screen.getByTestId("plugin-icon-fallback")).toBeTruthy();
    expect(screen.queryByTestId("plugin-icon")).toBeNull();
  });
});

describe("PluginCard: connection status chip (mockups §21/§22)", () => {
  it('renders the "Disabled" chip for a disabled plugin', () => {
    render(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);
    expect(screen.getByTestId("connection-status-pill").dataset.state).toBe("disabled");
  });

  it('renders the "Not connected" chip for an enabled plugin with no credentials yet', () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByTestId("connection-status-pill").dataset.state).toBe("disconnected");
  });

  it('renders the "Connected" chip once the integration reports a captured user', () => {
    mockedGlobalIntegration.mockReturnValue({
      data: integrationState({
        capturedUserId: { externalId: "42", displayName: "Octocat" },
      }),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof _useGlobalIntegration>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByTestId("connection-status-pill").dataset.state).toBe("connected");
  });

  it('renders the "Error" chip when the plugin lifecycle status is errored', () => {
    render(<PluginCard plugin={record({ status: "errored" })} hostApiVersion="1.0.0" />);
    expect(screen.getByTestId("connection-status-pill").dataset.state).toBe("errored");
  });
});

describe("PluginCard: enable Switch (FR-057, NFR-016)", () => {
  it("renders the Switch as selected for an enabled plugin", () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    const sw = screen.getByRole("switch") as HTMLInputElement;
    expect(sw.checked).toBe(true);
  });

  it("renders the Switch as unselected for a disabled plugin", () => {
    render(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);
    const sw = screen.getByRole("switch") as HTMLInputElement;
    expect(sw.checked).toBe(false);
  });

  it("calls the disable mutation when the Switch is toggled off", async () => {
    const user = userEvent.setup();
    const disableMutate = vi.fn();
    mockedDisable.mockReturnValue({
      mutate: disableMutate,
      isPending: false,
    } as unknown as ReturnType<typeof _useDisable>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("switch"));
    expect(disableMutate).toHaveBeenCalledWith("github-com");
  });

  it("calls the enable mutation when the Switch is toggled on", async () => {
    const user = userEvent.setup();
    const enableMutate = vi.fn();
    mockedEnable.mockReturnValue({
      mutate: enableMutate,
      isPending: false,
    } as unknown as ReturnType<typeof _useEnable>);
    render(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("switch"));
    expect(enableMutate).toHaveBeenCalledWith("github-com");
  });
});

describe("PluginCard: context-aware primary action (FR-072)", () => {
  it('labels the primary button "Connect" for a disabled plugin', () => {
    render(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it('labels the primary button "Connect" for an enabled plugin with no credentials yet', () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
  });

  it('labels the primary button "Configure" once credentials are captured', () => {
    mockedGlobalIntegration.mockReturnValue({
      data: integrationState({
        capturedUserId: { externalId: "42", displayName: "Octocat" },
      }),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof _useGlobalIntegration>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: "Configure" })).toBeTruthy();
  });

  it("disables the primary button when the plugin has no manifest", () => {
    render(
      <PluginCard plugin={record({ manifest: null, status: "invalid" })} hostApiVersion="1.0.0" />,
    );
    const button = screen.getByRole("button", { name: /Connect|Configure/ });
    expect(button).toBeDisabled();
  });
});

describe("PluginCard: Connect-on-disabled gesture (acceptance criterion 2)", () => {
  it("enables the plugin and opens the Configure dialog in the same click", async () => {
    const user = userEvent.setup();
    const enableMutate = vi.fn();
    mockedEnable.mockReturnValue({
      mutate: enableMutate,
      isPending: false,
    } as unknown as ReturnType<typeof _useEnable>);
    render(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(enableMutate).toHaveBeenCalledWith("github-com");
    expect(screen.getByRole("status").textContent).toMatch(/Loading plugin configuration/);
  });

  it("does NOT call enable when Connect is pressed on an already-enabled (disconnected) plugin", async () => {
    const user = userEvent.setup();
    const enableMutate = vi.fn();
    mockedEnable.mockReturnValue({
      mutate: enableMutate,
      isPending: false,
    } as unknown as ReturnType<typeof _useEnable>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);

    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(enableMutate).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/Loading plugin configuration/);
  });
});

describe("PluginCard: Configure dialog loading + error states", () => {
  it("fetches the effective global config eagerly for enabled plugins", () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    const firstCall = mockedGlobalIntegration.mock.calls[0];
    expect(firstCall).toEqual(["github-com", true]);
  });

  it("defers the effective config fetch for disabled plugins until Connect is pressed", async () => {
    const user = userEvent.setup();
    render(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);
    expect(mockedGlobalIntegration).toHaveBeenCalledWith("github-com", false);

    await user.click(screen.getByRole("button", { name: "Connect" }));
    const lastCall = mockedGlobalIntegration.mock.calls.at(-1);
    expect(lastCall).toEqual(["github-com", true]);
  });

  it("shows the loading dialog while the effective config is in flight", async () => {
    const user = userEvent.setup();
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("status").textContent).toMatch(/Loading plugin configuration/);
  });

  it("shows an error dialog with Retry and Close affordances when the effective config fetch fails", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mockedGlobalIntegration.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("Boom: integration manifest missing"),
      refetch,
    } as unknown as ReturnType<typeof _useGlobalIntegration>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/Couldn't load plugin configuration/)).toBeTruthy();
    expect(within(dialog).getByText(/Boom: integration manifest missing/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("PluginCard: secondary actions", () => {
  it("renders Uninstall only on third-party plugins (TC-018)", () => {
    const { rerender } = render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.queryByRole("button", { name: "Uninstall" })).toBeNull();
    rerender(<PluginCard plugin={record({ source: "user" })} hostApiVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: "Uninstall" })).toBeTruthy();
  });

  it("opens a confirmation dialog when Uninstall is pressed on a third-party plugin", async () => {
    const user = userEvent.setup();
    render(<PluginCard plugin={record({ source: "user" })} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("button", { name: "Uninstall" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Uninstall GitHub.com\?/i)).toBeTruthy();
  });

  it("calls the uninstall mutation when the dialog is confirmed", async () => {
    const user = userEvent.setup();
    const uninstallMutate = vi.fn();
    mockedUninstall.mockReturnValue({
      mutate: uninstallMutate,
      isPending: false,
    } as unknown as ReturnType<typeof _useUninstall>);
    render(<PluginCard plugin={record({ source: "user" })} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("button", { name: "Uninstall" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    expect(uninstallMutate).toHaveBeenCalledWith("github-com");
  });

  it("does not call the uninstall mutation when the dialog is cancelled", async () => {
    const user = userEvent.setup();
    const uninstallMutate = vi.fn();
    mockedUninstall.mockReturnValue({
      mutate: uninstallMutate,
      isPending: false,
    } as unknown as ReturnType<typeof _useUninstall>);
    render(<PluginCard plugin={record({ source: "user" })} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("button", { name: "Uninstall" }));
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(uninstallMutate).not.toHaveBeenCalled();
  });

  it("opens the View logs dialog when the action button is pressed (TC-017)", async () => {
    const user = userEvent.setup();
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    const actionRow = screen.getByTestId("plugin-card");
    await user.click(within(actionRow).getByRole("button", { name: "View logs" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("PluginCard: lifecycle banners", () => {
  it("shows errored banner when status is errored (TC-016)", () => {
    render(<PluginCard plugin={record({ status: "errored" })} hostApiVersion="1.0.0" />);
    expect(screen.getByTestId("plugin-errored-banner")).toBeTruthy();
  });

  it("shows incompatible banner with the manifest range and host version (TC-003)", () => {
    const r = record({
      status: "incompatible",
      manifest: manifest({ roubo: "^2.0.0" }),
    });
    render(<PluginCard plugin={r} hostApiVersion="1.0.0" />);
    const banner = screen.getByTestId("plugin-incompatible-banner");
    expect(banner.textContent).toContain("^2.0.0");
    expect(banner.textContent).toContain("1.0.0");
  });

  it("shows invalid banner with the supervisor's error message (TC-002)", () => {
    const r = record({
      status: "invalid",
      manifest: null,
      lastError: { code: "invalid-manifest", message: "Missing required field: entry" },
    });
    render(<PluginCard plugin={r} hostApiVersion="1.0.0" />);
    const banner = screen.getByTestId("plugin-invalid-banner");
    expect(banner.textContent).toContain("Missing required field: entry");
  });
});

describe("PluginCard: auth-problem branch (issue #204)", () => {
  it('labels the primary button "Sign in again" when live status is auth-problem', () => {
    mockedConnectionStatus.mockReturnValue({
      data: { state: "auth-problem", detail: "Token expired" },
      isFetching: false,
    } as unknown as ReturnType<typeof _useConnectionStatus>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
    expect(screen.getByTestId("connection-status-pill").dataset.state).toBe("auth-problem");
  });

  it("prefers live auth-problem over a captured-user derive-from-config connected", () => {
    mockedGlobalIntegration.mockReturnValue({
      data: integrationState({
        capturedUserId: { externalId: "42", displayName: "Octocat" },
      }),
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof _useGlobalIntegration>);
    mockedConnectionStatus.mockReturnValue({
      data: { state: "auth-problem" },
      isFetching: false,
    } as unknown as ReturnType<typeof _useConnectionStatus>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByTestId("connection-status-pill").dataset.state).toBe("auth-problem");
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy();
  });

  it("skips the connection-status query for disabled plugins", () => {
    render(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);
    expect(mockedConnectionStatus).toHaveBeenCalledWith("github-com", false);
  });

  it("enables the connection-status query for enabled plugins", () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(mockedConnectionStatus).toHaveBeenCalledWith("github-com", true);
  });
});

describe("PluginCard: rechecking lifecycle (issue #204)", () => {
  it('shows a pulsing "rechecking..." on the pill while the connection-status query is in flight', () => {
    mockedConnectionStatus.mockReturnValue({
      data: { state: "connected", checkedAt: "2026-05-26T09:00:00.000Z" },
      isFetching: true,
    } as unknown as ReturnType<typeof _useConnectionStatus>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    const timestamp = screen.getByTestId("connection-status-pill-timestamp");
    expect(timestamp).toHaveTextContent("rechecking...");
    expect(timestamp.className).toContain("animate-pulse");
  });

  it('does NOT pulse "rechecking..." once the query has settled', () => {
    mockedConnectionStatus.mockReturnValue({
      data: { state: "connected", checkedAt: "2026-05-26T09:00:00.000Z" },
      isFetching: false,
    } as unknown as ReturnType<typeof _useConnectionStatus>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    const timestamp = screen.getByTestId("connection-status-pill-timestamp");
    expect(timestamp.textContent).not.toMatch(/rechecking/);
  });
});

describe("PluginCard: consent affordance for component plugins (issue #490)", () => {
  const declared = componentManifest().permissions;

  function consentStatus(consentedAt?: string) {
    return {
      data: { declared, firstParty: true, ...(consentedAt ? { consentedAt } : {}) },
    } as unknown as ReturnType<typeof _useConsentStatus>;
  }

  it("gates the consent fetch to component cards and shows Review permissions when unconsented", () => {
    mockedConsentStatus.mockReturnValue(consentStatus());
    render(<PluginCard plugin={componentRecord()} hostApiVersion="1.0.0" />);
    expect(mockedConsentStatus).toHaveBeenCalledWith("database", true);
    expect(screen.getByRole("button", { name: "Review permissions" })).toBeTruthy();
  });

  it("hides Review permissions once the component plugin is consented", () => {
    mockedConsentStatus.mockReturnValue(consentStatus("2026-07-01T00:00:00.000Z"));
    render(<PluginCard plugin={componentRecord()} hostApiVersion="1.0.0" />);
    expect(screen.queryByRole("button", { name: "Review permissions" })).toBeNull();
  });

  it("hides Review permissions while the consent status is still loading", () => {
    // Default mock: data undefined.
    render(<PluginCard plugin={componentRecord()} hostApiVersion="1.0.0" />);
    expect(screen.queryByRole("button", { name: "Review permissions" })).toBeNull();
  });

  it("never fetches consent or shows the affordance for an integration plugin", () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(mockedConsentStatus).toHaveBeenCalledWith("github-com", false);
    expect(screen.queryByRole("button", { name: "Review permissions" })).toBeNull();
  });

  it("does not show the affordance for a user (non-component) plugin", () => {
    mockedConsentStatus.mockReturnValue(consentStatus());
    render(<PluginCard plugin={record({ source: "user" })} hostApiVersion="1.0.0" />);
    expect(screen.queryByRole("button", { name: "Review permissions" })).toBeNull();
  });

  it("opens the consent dialog and grants consent with the declared categories", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn((_vars, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    mockedConsentStatus.mockReturnValue(consentStatus());
    mockedGrantConsent.mockReturnValue({
      mutate,
      isPending: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof _useGrantConsent>);
    render(<PluginCard plugin={componentRecord()} hostApiVersion="1.0.0" />);

    await user.click(screen.getByRole("button", { name: "Review permissions" }));
    const dialog = screen.getByTestId("consent-review-dialog");
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByTestId("consent-review-confirm"));

    expect(mutate.mock.calls[0][0]).toEqual({
      pluginId: "database",
      acknowledgedCategories: ["docker"],
    });
    // Success closes the dialog (consentOpen -> false unmounts it).
    expect(screen.queryByTestId("consent-review-dialog")).toBeNull();
  });
});

describe("PluginCard: keyboard tab order (TC-135, NFR-016)", () => {
  it("places the enable Switch before the primary action button in DOM order", () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    const tile = screen.getByTestId("plugin-card");
    const allNodes = Array.from(tile.querySelectorAll<HTMLElement>("button, [role=switch]"));
    const switchIndex = allNodes.findIndex((el) => el.getAttribute("role") === "switch");
    const primaryIndex = allNodes.findIndex(
      (el) => el.textContent === "Connect" || el.textContent === "Configure",
    );
    expect(switchIndex).toBeGreaterThanOrEqual(0);
    expect(primaryIndex).toBeGreaterThan(switchIndex);
  });
});
