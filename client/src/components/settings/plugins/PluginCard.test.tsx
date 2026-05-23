// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginRecord, PluginManifest, PluginStatus } from "@roubo/shared";

vi.mock("../../../hooks/usePlugins");
vi.mock("../../../hooks/useGlobalPluginIntegration", () => ({
  useGlobalPluginIntegration: vi.fn(),
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

beforeEach(() => {
  const enableMutate = vi.fn();
  const disableMutate = vi.fn();
  mockedEnable.mockReturnValue({
    mutate: enableMutate,
    isPending: false,
  } as unknown as ReturnType<typeof _useEnable>);
  mockedDisable.mockReturnValue({
    mutate: disableMutate,
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
  // The Configure button on the global Plugins page lazily fetches the
  // effective config when the dialog opens. Default to "no data yet" so the
  // PluginCard tests that never open Configure don't accidentally instantiate
  // the dialog.
  mockedGlobalIntegration.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof _useGlobalIntegration>);
});

describe("PluginCard (TC-001, TC-013, TC-018)", () => {
  it("renders name, version, description, and an Enabled pill for a healthy bundled plugin", () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByText("GitHub.com")).toBeTruthy();
    expect(screen.getByText("v1.2.3")).toBeTruthy();
    expect(screen.getByText("Pulls issues from GitHub.com")).toBeTruthy();
    expect(screen.getByTestId("plugin-status-pill").dataset.status).toBe("enabled");
    expect(screen.getByTestId("plugin-source-label").dataset.source).toBe("bundled");
  });

  it("shows Disable for enabled plugins and Enable for disabled ones", async () => {
    const { rerender } = render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
    rerender(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: "Enable" })).toBeTruthy();
  });

  it("calls disable mutation when Disable is pressed", async () => {
    const user = userEvent.setup();
    const disableMutate = vi.fn();
    mockedDisable.mockReturnValue({
      mutate: disableMutate,
      isPending: false,
    } as unknown as ReturnType<typeof _useDisable>);
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("button", { name: "Disable" }));
    expect(disableMutate).toHaveBeenCalledWith("github-com");
  });

  it("calls enable mutation when Enable is pressed on a disabled plugin", async () => {
    const user = userEvent.setup();
    const enableMutate = vi.fn();
    mockedEnable.mockReturnValue({
      mutate: enableMutate,
      isPending: false,
    } as unknown as ReturnType<typeof _useEnable>);
    render(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("button", { name: "Enable" }));
    expect(enableMutate).toHaveBeenCalledWith("github-com");
  });

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
    expect(dialog).toBeTruthy();
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

  it("renders Configure as enabled for an enabled plugin with a manifest", () => {
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: "Configure" })).not.toBeDisabled();
  });

  it("renders Configure as disabled for a disabled plugin", () => {
    render(<PluginCard plugin={record({ status: "disabled" })} hostApiVersion="1.0.0" />);
    expect(screen.getByRole("button", { name: "Configure" })).toBeDisabled();
  });

  it("renders Configure as disabled when the plugin has no manifest (e.g. invalid)", () => {
    render(
      <PluginCard plugin={record({ manifest: null, status: "invalid" })} hostApiVersion="1.0.0" />,
    );
    expect(screen.getByRole("button", { name: "Configure" })).toBeDisabled();
  });

  it("lazily fetches the effective global config only after the Configure dialog opens", async () => {
    const user = userEvent.setup();
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    // Before opening, the hook is called with enabled=false.
    expect(mockedGlobalIntegration).toHaveBeenCalledWith("github-com", false);

    await user.click(screen.getByRole("button", { name: "Configure" }));
    // Latest call after opening should be enabled=true.
    const lastCall = mockedGlobalIntegration.mock.calls.at(-1);
    expect(lastCall).toEqual(["github-com", true]);
  });

  it("shows a loading dialog while the effective config is in flight, then renders the dialog", async () => {
    const user = userEvent.setup();
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    await user.click(screen.getByRole("button", { name: "Configure" }));
    expect(screen.getByRole("status").textContent).toMatch(/Loading plugin configuration/);
  });

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

  it("opens the View logs dialog when the action button is pressed (TC-017)", async () => {
    const user = userEvent.setup();
    render(<PluginCard plugin={record()} hostApiVersion="1.0.0" />);
    const actionRow = screen.getByTestId("plugin-card");
    await user.click(within(actionRow).getByRole("button", { name: "View logs" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
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
