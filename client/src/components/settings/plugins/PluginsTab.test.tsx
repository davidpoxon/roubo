// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PluginRecord } from "@roubo/shared";

vi.mock("../../../hooks/usePlugins");
import {
  usePlugins as _usePlugins,
  useDisablePlugin as _useDisable,
  useEnablePlugin as _useEnable,
  useRestartPlugin as _useRestart,
  usePluginLogs as _usePluginLogs,
} from "../../../hooks/usePlugins";
import PluginsTab from "./PluginsTab";

const mockedUsePlugins = vi.mocked(_usePlugins);
const mockedEnable = vi.mocked(_useEnable);
const mockedDisable = vi.mocked(_useDisable);
const mockedRestart = vi.mocked(_useRestart);
const mockedLogs = vi.mocked(_usePluginLogs);

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
  mockedLogs.mockReturnValue({
    data: { lines: [] },
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof _usePluginLogs>);
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
    expect(installBtn).toBeDisabled();

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
});
