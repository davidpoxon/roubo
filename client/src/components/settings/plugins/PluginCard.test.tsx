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
import {
  useDisablePlugin as _useDisable,
  useEnablePlugin as _useEnable,
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
});

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
