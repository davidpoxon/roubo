// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginRecord } from "@roubo/shared";
import ToastProvider from "../../ToastProvider";

vi.mock("../../../hooks/usePlugins");
import {
  usePlugins as _usePlugins,
  useDisablePlugin as _useDisable,
  useEnablePlugin as _useEnable,
  useRestartPlugin as _useRestart,
  useUninstallPlugin as _useUninstall,
  usePluginLogs as _usePluginLogs,
  useInstallPluginPreview as _useInstallPluginPreview,
  useInstallPluginConfirm as _useInstallPluginConfirm,
  useInstallPluginCancel as _useInstallPluginCancel,
} from "../../../hooks/usePlugins";
import PluginsTab from "./PluginsTab";

const mockedUsePlugins = vi.mocked(_usePlugins);
const mockedEnable = vi.mocked(_useEnable);
const mockedDisable = vi.mocked(_useDisable);
const mockedRestart = vi.mocked(_useRestart);
const mockedUninstall = vi.mocked(_useUninstall);
const mockedLogs = vi.mocked(_usePluginLogs);
const mockedInstallPreview = vi.mocked(_useInstallPluginPreview);
const mockedInstallConfirm = vi.mocked(_useInstallPluginConfirm);
const mockedInstallCancel = vi.mocked(_useInstallPluginCancel);

function record(over: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: "github-com",
    manifest: {
      id: "github-com",
      name: "GitHub.com",
      version: "1.0.0",
      description: "GitHub.com integration",
      kind: "integration",
      roubo: "^1.0.0",
      entry: "dist/index.js",
      permissions: {
        network: { hosts: [] },
        credentials: { slots: [] },
        filesystem: { paths: [] },
        processes: false,
      },
    },
    manifestPath: "/p/github-com/roubo-plugin.yaml",
    pluginDir: "/p/github-com",
    source: "bundled",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 1,
    ...over,
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
  mockedInstallPreview.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof _useInstallPluginPreview>);
  mockedInstallConfirm.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof _useInstallPluginConfirm>);
  mockedInstallCancel.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
  } as unknown as ReturnType<typeof _useInstallPluginCancel>);
});

describe("PluginsTab (TC-001, TC-018)", () => {
  it("renders bundled and third-party sections with the Install plugin CTA", () => {
    mockedUsePlugins.mockReturnValue({
      data: {
        hostApiVersion: "1.0.0",
        plugins: [
          record(),
          record({ id: "my-tool", source: "user", manifest: null, status: "disabled" }),
        ],
      },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof _usePlugins>);

    render(<PluginsTab />);

    expect(screen.getByText("Plugins")).toBeTruthy();
    const installBtn = screen.getByTestId("install-plugin");
    expect(installBtn).toBeEnabled();

    const cards = screen.getAllByTestId("plugin-card");
    expect(cards).toHaveLength(2);
  });

  it("shows the empty-state message when there are no third-party plugins", () => {
    mockedUsePlugins.mockReturnValue({
      data: { hostApiVersion: "1.0.0", plugins: [record()] },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof _usePlugins>);

    render(<PluginsTab />);
    expect(screen.getByText(/No third-party plugins installed yet/i)).toBeTruthy();
  });

  it("shows a loader while loading", () => {
    mockedUsePlugins.mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    } as unknown as ReturnType<typeof _usePlugins>);

    render(<PluginsTab />);
    expect(screen.getByText("Loading plugins...")).toBeTruthy();
  });

  it("surfaces a fetch error", () => {
    mockedUsePlugins.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("offline"),
    } as unknown as ReturnType<typeof _usePlugins>);

    render(<PluginsTab />);
    expect(screen.getByRole("alert").textContent).toContain("offline");
  });

  it("WU-027 / TC-046: Escape closes the Install dialog and restores focus to the Install button", async () => {
    const user = userEvent.setup();
    mockedUsePlugins.mockReturnValue({
      data: { hostApiVersion: "1.0.0", plugins: [record()] },
      isLoading: false,
      error: null,
    } as unknown as ReturnType<typeof _usePlugins>);

    render(
      <ToastProvider>
        <PluginsTab />
      </ToastProvider>,
    );

    const installBtn = screen.getByTestId("install-plugin");
    await user.click(installBtn);

    // Dialog opens with its semantic role and accessible name.
    expect(await screen.findByRole("dialog", { name: /install plugin/i })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    // React Aria's DialogTrigger restores focus to the originating trigger
    // button (TC-046). After the modal unmounts, the Install button regains
    // focus so the user can re-trigger or tab onward without losing context.
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /install plugin/i })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(installBtn).toHaveFocus();
    });
  });
});
