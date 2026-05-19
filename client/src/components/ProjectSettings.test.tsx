// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/renderWithProviders";
import ProjectSettings from "./ProjectSettings";
import type { BlueprintMeta } from "@roubo/shared";
import { DEFAULT_BLUEPRINT_SETTINGS, DEFAULT_CLAUDE_CODE_SETTINGS } from "@roubo/shared";

vi.mock("react-router-dom", () => ({
  useNavigate: vi.fn(),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: vi.fn(),
  useRecheckClaudeCode: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock("../hooks/useBlueprints", () => ({
  useGlobalBlueprints: vi.fn(),
  useDeleteGlobalBlueprint: vi.fn(),
  useDuplicateGlobalBlueprint: vi.fn(),
}));

vi.mock("../hooks/useToast", () => ({
  useToast: vi.fn(() => ({ addToast: vi.fn(), removeToast: vi.fn() })),
}));

vi.mock("./blueprint-editor/blueprintIcons", () => ({
  getBlueprintIcon: () => () => null,
  BLUEPRINT_ICONS: [],
  BLUEPRINT_ICON_MAP: {},
  DEFAULT_BLUEPRINT_ICON: "file-text",
}));

vi.mock("./blueprint-editor/DeleteBlueprintDialog", () => ({
  default: () => null,
}));

vi.mock("../hooks/useGitHubAuth", () => ({
  useGitHubAuth: vi.fn(),
  useConnectGitHub: vi.fn(),
  useDisconnectGitHub: vi.fn(),
}));

vi.mock("./DirectoryPicker", () => ({
  default: ({ onChange }: { onChange: (val: string) => void }) => (
    <input data-testid="directory-picker" onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { useNavigate } from "react-router-dom";
import { useSettings } from "../hooks/useSettings";
import {
  useGlobalBlueprints,
  useDeleteGlobalBlueprint,
  useDuplicateGlobalBlueprint,
} from "../hooks/useBlueprints";
import { useGitHubAuth, useConnectGitHub, useDisconnectGitHub } from "../hooks/useGitHubAuth";
import { useToast } from "../hooks/useToast";
import { ApiError } from "../lib/api";

const mockedUseNavigate = vi.mocked(useNavigate);
const mockedUseSettings = vi.mocked(useSettings);
const mockedUseGlobalBlueprints = vi.mocked(useGlobalBlueprints);
const mockedUseDeleteGlobalBlueprint = vi.mocked(useDeleteGlobalBlueprint);
const mockedUseDuplicateGlobalBlueprint = vi.mocked(useDuplicateGlobalBlueprint);
const mockedUseToast = vi.mocked(useToast);
const mockedUseGitHubAuth = vi.mocked(useGitHubAuth);
const mockedUseConnectGitHub = vi.mocked(useConnectGitHub);
const mockedUseDisconnectGitHub = vi.mocked(useDisconnectGitHub);

const defaultSettings = {
  theme: "dark" as const,
  blueprints: DEFAULT_BLUEPRINT_SETTINGS,
  claudeCode: DEFAULT_CLAUDE_CODE_SETTINGS,
  claudeCodeAutoModeAvailable: true,
  contextWindow: 200_000,
};

const noopMutation = {
  mutate: vi.fn(),
  mutateAsync: vi.fn(),
  isPending: false,
  isError: false,
  isSuccess: false,
  error: null,
  reset: vi.fn(),
};

function setupDefaultMocks() {
  mockedUseNavigate.mockReturnValue(vi.fn());
  mockedUseSettings.mockReturnValue({
    settings: defaultSettings,
    isLoading: false,
    updateSettings: vi.fn(),
  });
  mockedUseGlobalBlueprints.mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useGlobalBlueprints>);
  mockedUseDeleteGlobalBlueprint.mockReturnValue(
    noopMutation as unknown as ReturnType<typeof useDeleteGlobalBlueprint>,
  );
  mockedUseDuplicateGlobalBlueprint.mockReturnValue(
    noopMutation as unknown as ReturnType<typeof useDuplicateGlobalBlueprint>,
  );
  mockedUseGitHubAuth.mockReturnValue({
    status: undefined,
    isLoading: false,
    error: null,
  });
  mockedUseConnectGitHub.mockReturnValue(
    noopMutation as unknown as ReturnType<typeof useConnectGitHub>,
  );
  mockedUseDisconnectGitHub.mockReturnValue(
    noopMutation as unknown as ReturnType<typeof useDisconnectGitHub>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  setupDefaultMocks();
});

function render() {
  return renderWithProviders(<ProjectSettings />);
}

describe("ProjectSettings", () => {
  describe("layout", () => {
    it("renders the Settings heading", () => {
      render();
      expect(screen.getByText("Settings")).toBeInTheDocument();
    });

    it("renders all five tab labels", () => {
      render();
      expect(screen.getByRole("tab", { name: "Bench Defaults" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Appearance" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Blueprints" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Integrations" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Claude Code" })).toBeInTheDocument();
    });

    it("defaults to the Bench Defaults tab", () => {
      render();
      expect(screen.getByRole("tab", { name: "Bench Defaults" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  describe("Appearance tab", () => {
    it("renders three theme options", async () => {
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Appearance" }));

      expect(screen.getByText("Light")).toBeInTheDocument();
      expect(screen.getByText("Dark")).toBeInTheDocument();
      expect(screen.getByText("System")).toBeInTheDocument();
    });

    it("highlights the current theme from settings", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          theme: "light",
          blueprints: DEFAULT_BLUEPRINT_SETTINGS,
          claudeCodeAutoModeAvailable: true,
          contextWindow: 200_000,
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Appearance" }));

      // React Aria passes aria-label to the underlying input; checked state is native
      const lightRadio = screen.getByRole("radio", { name: "Light" });
      expect(lightRadio).toBeChecked();
    });

    it("calls updateSettings when a theme option is selected", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: defaultSettings,
        isLoading: false,
        updateSettings,
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Appearance" }));

      const lightRadio = screen.getByRole("radio", { name: "Light" });
      await user.click(lightRadio);
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: "light" }));
    });
  });

  describe("Blueprints tab", () => {
    it("renders auto-inject toggle", async () => {
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));
      expect(screen.getByText("Auto-inject blueprint")).toBeInTheDocument();
    });

    it("renders auto-execute toggle", async () => {
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));
      expect(screen.getByText("Auto-execute")).toBeInTheDocument();
    });

    it("auto-execute is disabled when auto-inject is off", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          theme: "dark",
          blueprints: {
            autoInject: false,
            autoExecute: false,
            defaultBlueprintId: "feature-dev",
          },
          claudeCodeAutoModeAvailable: true,
          contextWindow: 200_000,
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));

      // The auto-execute switch should be disabled
      const switches = screen.getAllByRole("switch");
      const autoExecuteSwitch = switches.find(
        (s) =>
          s.closest('[class*="opacity-40"]') !== null || s.getAttribute("aria-disabled") === "true",
      );
      expect(autoExecuteSwitch).toBeDefined();
    });

    it("renders blueprint options", async () => {
      const blueprints: BlueprintMeta[] = [
        {
          id: "feature-dev",
          name: "Feature Dev",
          description: "Build features",
          icon: "",
          source: "app",
        },
        {
          id: "review",
          name: "Code Review",
          description: "Review code",
          icon: "",
          source: "app",
        },
      ];
      mockedUseGlobalBlueprints.mockReturnValue({
        data: blueprints,
      } as ReturnType<typeof useGlobalBlueprints>);
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));

      expect(screen.getAllByText("Feature Dev").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Code Review").length).toBeGreaterThanOrEqual(1);
    });

    it('renders "Inherit from global default" option in app default picker', async () => {
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));
      expect(screen.getByText("Inherit from global default")).toBeInTheDocument();
    });

    it('calls updateSettings with undefined defaultBlueprintId when "Inherit from global default" is selected in app picker', async () => {
      const updateSettingsMock = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: {
          theme: "dark",
          blueprints: {
            autoInject: true,
            autoExecute: true,
            defaultBlueprintId: "some-bp",
          },
          claudeCodeAutoModeAvailable: true,
          contextWindow: 200_000,
        },
        isLoading: false,
        updateSettings: updateSettingsMock,
      });

      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));
      await user.click(screen.getByText("Inherit from global default"));

      expect(updateSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprints: expect.not.objectContaining({
            defaultBlueprintId: expect.anything(),
          }),
        }),
      );
    });
  });

  describe("Integrations tab — GitHub", () => {
    async function openIntegrationsTab() {
      const user = userEvent.setup();
      render();
      await user.click(screen.getByRole("tab", { name: "Integrations" }));
      return user;
    }

    it("shows loading skeleton while auth status is loading", async () => {
      mockedUseGitHubAuth.mockReturnValue({
        status: undefined,
        isLoading: true,
        error: null,
      });
      await openIntegrationsTab();

      // The skeleton pulse element should be present
      const skeleton = document.querySelector(".animate-pulse");
      expect(skeleton).not.toBeNull();
    });

    it('shows "Not connected" badge when not authenticated', async () => {
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: false },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.getByText("Not connected")).toBeInTheDocument();
    });

    it('shows "Connect GitHub" button when not authenticated', async () => {
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: false },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.getByRole("button", { name: /connect github/i })).toBeInTheDocument();
    });

    it('shows "Connected" badge when authenticated', async () => {
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true, username: "octocat" },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    it("shows signed-in username when connected", async () => {
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true, username: "octocat" },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.getByText("octocat")).toBeInTheDocument();
    });

    it("calls connectGitHub.mutate with onSuccess callback when Connect GitHub button is pressed", async () => {
      const mutate = vi.fn();
      mockedUseConnectGitHub.mockReturnValue({
        ...noopMutation,
        mutate,
      } as unknown as ReturnType<typeof useConnectGitHub>);
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: false },
        isLoading: false,
        error: null,
      });
      const user = await openIntegrationsTab();

      await user.click(screen.getByRole("button", { name: /connect github/i }));
      expect(mutate).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );
    });

    it('shows "Authorizing…" badge and waiting message after connect succeeds', async () => {
      let capturedOnSuccess: (() => void) | undefined;
      const mutate = vi.fn((_arg: unknown, callbacks?: { onSuccess?: () => void }) => {
        capturedOnSuccess = callbacks?.onSuccess;
      });
      mockedUseConnectGitHub.mockReturnValue({
        ...noopMutation,
        mutate,
      } as unknown as ReturnType<typeof useConnectGitHub>);
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: false },
        isLoading: false,
        error: null,
      });
      const user = await openIntegrationsTab();

      await user.click(screen.getByRole("button", { name: /connect github/i }));
      act(() => {
        capturedOnSuccess?.();
      });

      expect(screen.getByText("Authorizing…")).toBeInTheDocument();
      expect(screen.getByText(/waiting for authorization/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it('returns to "Not connected" state when Cancel is pressed during OAuth', async () => {
      let capturedOnSuccess: (() => void) | undefined;
      const mutate = vi.fn((_arg: unknown, callbacks?: { onSuccess?: () => void }) => {
        capturedOnSuccess = callbacks?.onSuccess;
      });
      mockedUseConnectGitHub.mockReturnValue({
        ...noopMutation,
        mutate,
      } as unknown as ReturnType<typeof useConnectGitHub>);
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: false },
        isLoading: false,
        error: null,
      });
      const user = await openIntegrationsTab();

      await user.click(screen.getByRole("button", { name: /connect github/i }));
      act(() => {
        capturedOnSuccess?.();
      });

      expect(screen.getByText("Authorizing…")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /cancel/i }));
      expect(screen.getByText("Not connected")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /connect github/i })).toBeInTheDocument();
    });

    it("disables Connect GitHub button and shows loading state while pending", async () => {
      mockedUseConnectGitHub.mockReturnValue({
        ...noopMutation,
        isPending: true,
      } as unknown as ReturnType<typeof useConnectGitHub>);
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: false },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();

      const button = screen.getByRole("button", { name: /opening/i });
      expect(button).toBeDisabled();
    });

    it("shows error message when connectGitHub fails", async () => {
      mockedUseConnectGitHub.mockReturnValue({
        ...noopMutation,
        isError: true,
      } as unknown as ReturnType<typeof useConnectGitHub>);
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: false },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();

      expect(screen.getByText(/could not open github/i)).toBeInTheDocument();
    });

    it('shows "unknown" when connected with no username', async () => {
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.getByText("unknown")).toBeInTheDocument();
    });

    it("shows Disconnect button when connected", async () => {
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true, username: "octocat" },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
    });

    it("calls disconnectGitHub.mutate when Disconnect button is pressed", async () => {
      const mutate = vi.fn();
      mockedUseDisconnectGitHub.mockReturnValue({
        ...noopMutation,
        mutate,
      } as unknown as ReturnType<typeof useDisconnectGitHub>);
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true, username: "octocat" },
        isLoading: false,
        error: null,
      });
      const user = await openIntegrationsTab();
      await user.click(screen.getByRole("button", { name: /disconnect/i }));
      expect(mutate).toHaveBeenCalled();
    });

    it("disables Disconnect button while pending", async () => {
      mockedUseDisconnectGitHub.mockReturnValue({
        ...noopMutation,
        isPending: true,
      } as unknown as ReturnType<typeof useDisconnectGitHub>);
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true, username: "octocat" },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.getByRole("button", { name: /disconnect/i })).toBeDisabled();
    });

    it("shows error message when disconnect fails", async () => {
      mockedUseDisconnectGitHub.mockReturnValue({
        ...noopMutation,
        isError: true,
      } as unknown as ReturnType<typeof useDisconnectGitHub>);
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true, username: "octocat" },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.getByText(/could not disconnect/i)).toBeInTheDocument();
    });

    it("shows reconnect prompt when scopesOutdated is true", async () => {
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true, username: "octocat", scopesOutdated: true },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.getByText(/updated permissions required/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
    });

    it("does not show reconnect prompt when scopesOutdated is false", async () => {
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true, username: "octocat", scopesOutdated: false },
        isLoading: false,
        error: null,
      });
      await openIntegrationsTab();
      expect(screen.queryByText(/updated permissions required/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();
    });

    it("calls disconnect then connect mutations and transitions to awaiting state when Reconnect is pressed", async () => {
      let capturedDisconnectOnSuccess: (() => void) | undefined;
      const disconnectMutate = vi.fn((_arg: unknown, callbacks?: { onSuccess?: () => void }) => {
        capturedDisconnectOnSuccess = callbacks?.onSuccess;
      });
      let capturedConnectOnSuccess: (() => void) | undefined;
      const connectMutate = vi.fn((_arg: unknown, callbacks?: { onSuccess?: () => void }) => {
        capturedConnectOnSuccess = callbacks?.onSuccess;
      });
      mockedUseDisconnectGitHub.mockReturnValue({
        ...noopMutation,
        mutate: disconnectMutate,
      } as unknown as ReturnType<typeof useDisconnectGitHub>);
      mockedUseConnectGitHub.mockReturnValue({
        ...noopMutation,
        mutate: connectMutate,
      } as unknown as ReturnType<typeof useConnectGitHub>);
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: true, username: "octocat", scopesOutdated: true },
        isLoading: false,
        error: null,
      });
      const user = await openIntegrationsTab();

      await user.click(screen.getByRole("button", { name: /reconnect/i }));
      expect(disconnectMutate).toHaveBeenCalled();

      act(() => {
        capturedDisconnectOnSuccess?.();
      });
      expect(connectMutate).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ onSuccess: expect.any(Function) }),
      );

      // After disconnect succeeds the status returns connected: false; firing connect's
      // onSuccess sets awaitingOAuth: true, which combined with !connected renders the badge.
      mockedUseGitHubAuth.mockReturnValue({
        status: { connected: false },
        isLoading: false,
        error: null,
      });
      act(() => {
        capturedConnectOnSuccess?.();
      });
      expect(screen.getByText("Authorizing…")).toBeInTheDocument();
    });
  });

  describe("Blueprints tab — interactions", () => {
    it("calls updateSettings when auto-inject toggle is clicked", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: defaultSettings,
        isLoading: false,
        updateSettings,
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));

      const switches = screen.getAllByRole("switch");
      const autoInjectSwitch = switches[0];
      await user.click(autoInjectSwitch);
      expect(updateSettings).toHaveBeenCalled();
    });

    it("calls updateSettings when a blueprint option is selected", async () => {
      const updateSettings = vi.fn();
      const blueprints: BlueprintMeta[] = [
        {
          id: "feature-dev",
          name: "Feature Dev",
          description: "",
          icon: "",
          source: "app",
        },
        {
          id: "review",
          name: "Code Review",
          description: "",
          icon: "",
          source: "app",
        },
      ];
      mockedUseGlobalBlueprints.mockReturnValue({
        data: blueprints,
      } as ReturnType<typeof useGlobalBlueprints>);
      mockedUseSettings.mockReturnValue({
        settings: defaultSettings,
        isLoading: false,
        updateSettings,
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));

      const defaultSection = screen.getByText("App Default").closest("section") as HTMLElement;
      await user.click(within(defaultSection).getByText("Feature Dev"));
      expect(updateSettings).toHaveBeenCalled();
    });

    it("does not call updateSettings when settings is undefined", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: undefined,
        isLoading: true,
        updateSettings,
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));

      const switches = screen.getAllByRole("switch");
      await user.click(switches[0]);
      expect(updateSettings).not.toHaveBeenCalled();
    });
  });

  describe("Bench Defaults tab", () => {
    async function openBenchesTab() {
      const user = userEvent.setup();
      render();
      await user.click(screen.getByRole("tab", { name: "Bench Defaults" }));
      return user;
    }

    it("renders the auto-clear toggle", async () => {
      await openBenchesTab();
      expect(
        screen.getByRole("switch", { name: /auto-clear completed issues/i }),
      ).toBeInTheDocument();
    });

    it("toggle is checked when autoClear is true", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openBenchesTab();
      expect(screen.getByRole("switch", { name: /auto-clear completed issues/i })).toBeChecked();
    });

    it("toggle is unchecked when autoClear is false", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: false,
            enforceIssueDependencies: false,
            workUnitAutoClear: false,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openBenchesTab();
      expect(
        screen.getByRole("switch", { name: /auto-clear completed issues/i }),
      ).not.toBeChecked();
    });

    it("calls updateSettings with toggled value when clicked", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings,
      });
      const user = await openBenchesTab();
      await user.click(screen.getByRole("switch", { name: /auto-clear completed issues/i }));
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          benches: {
            autoClear: false,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        }),
      );
    });

    it("does not call updateSettings when settings is undefined", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: undefined,
        isLoading: true,
        updateSettings,
      });
      const user = await openBenchesTab();
      await user.click(screen.getByRole("switch", { name: /auto-clear completed issues/i }));
      expect(updateSettings).not.toHaveBeenCalled();
    });

    it("renders the enforce issue dependencies toggle", async () => {
      await openBenchesTab();
      expect(
        screen.getByRole("switch", { name: /enforce issue dependencies/i }),
      ).toBeInTheDocument();
    });

    it("enforce toggle is checked when enforceIssueDependencies is true", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: true,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openBenchesTab();
      expect(screen.getByRole("switch", { name: /enforce issue dependencies/i })).toBeChecked();
    });

    it("enforce toggle is unchecked when enforceIssueDependencies is false", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openBenchesTab();
      expect(screen.getByRole("switch", { name: /enforce issue dependencies/i })).not.toBeChecked();
    });

    it("calls updateSettings with toggled enforceIssueDependencies when clicked", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings,
      });
      const user = await openBenchesTab();
      await user.click(screen.getByRole("switch", { name: /enforce issue dependencies/i }));
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          benches: {
            autoClear: true,
            enforceIssueDependencies: true,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        }),
      );
    });

    it("renders the work-unit auto-clear toggle", async () => {
      await openBenchesTab();
      expect(
        screen.getByRole("switch", {
          name: /auto-clear meta-repo benches by pr status/i,
        }),
      ).toBeInTheDocument();
    });

    it("work-unit auto-clear toggle is checked when workUnitAutoClear is true", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openBenchesTab();
      expect(
        screen.getByRole("switch", {
          name: /auto-clear meta-repo benches by pr status/i,
        }),
      ).toBeChecked();
    });

    it("work-unit auto-clear toggle is unchecked when workUnitAutoClear is false", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: false,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openBenchesTab();
      expect(
        screen.getByRole("switch", {
          name: /auto-clear meta-repo benches by pr status/i,
        }),
      ).not.toBeChecked();
    });

    it("calls updateSettings with toggled workUnitAutoClear when clicked", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings,
      });
      const user = await openBenchesTab();
      await user.click(
        screen.getByRole("switch", {
          name: /auto-clear meta-repo benches by pr status/i,
        }),
      );
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: false,
            autoStartComponents: false,
          },
        }),
      );
    });

    it("work-unit auto-clear toggle is disabled when autoClear is off", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: false,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openBenchesTab();
      const toggle = screen.getByRole("switch", {
        name: /auto-clear meta-repo benches by pr status/i,
      });
      expect(toggle).toBeDisabled();
    });

    it("renders the auto-start components toggle", async () => {
      await openBenchesTab();
      expect(
        screen.getByRole("switch", { name: /auto-start components on bench creation/i }),
      ).toBeInTheDocument();
    });

    it("auto-start components toggle is unchecked by default (off)", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openBenchesTab();
      expect(
        screen.getByRole("switch", { name: /auto-start components on bench creation/i }),
      ).not.toBeChecked();
    });

    it("auto-start components toggle is checked when autoStartComponents is true", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: true,
          },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openBenchesTab();
      expect(
        screen.getByRole("switch", { name: /auto-start components on bench creation/i }),
      ).toBeChecked();
    });

    it("calls updateSettings with toggled autoStartComponents when clicked", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: false,
          },
        },
        isLoading: false,
        updateSettings,
      });
      const user = await openBenchesTab();
      await user.click(
        screen.getByRole("switch", { name: /auto-start components on bench creation/i }),
      );
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          benches: {
            autoClear: true,
            enforceIssueDependencies: false,
            workUnitAutoClear: true,
            autoStartComponents: true,
          },
        }),
      );
    });
  });

  describe("Appearance tab — null settings fallback", () => {
    it("defaults to dark theme when settings is undefined", async () => {
      mockedUseSettings.mockReturnValue({
        settings: undefined,
        isLoading: true,
        updateSettings: vi.fn(),
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Appearance" }));

      const darkRadio = screen.getByRole("radio", { name: "Dark" });
      expect(darkRadio).toBeChecked();
    });
  });

  describe("Claude Code tab", () => {
    async function openClaudeCodeTab() {
      const user = userEvent.setup();
      render();
      await user.click(screen.getByRole("tab", { name: "Claude Code" }));
      return user;
    }

    it("renders the enable auto mode toggle", async () => {
      await openClaudeCodeTab();
      expect(screen.getByRole("switch", { name: /enable auto mode/i })).toBeInTheDocument();
    });

    it("renders the start in plan mode toggle", async () => {
      await openClaudeCodeTab();
      expect(screen.getByRole("switch", { name: /start in plan mode/i })).toBeInTheDocument();
    });

    it("calls updateSettings when auto mode is toggled on", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          claudeCode: { enableAutoMode: false, startInPlanMode: false },
        },
        isLoading: false,
        updateSettings,
      });
      const user = await openClaudeCodeTab();
      await user.click(screen.getByRole("switch", { name: /enable auto mode/i }));
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          claudeCode: expect.objectContaining({ enableAutoMode: true }),
        }),
      );
    });

    it("calls updateSettings when plan mode is toggled on", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          claudeCode: { enableAutoMode: true, startInPlanMode: false },
        },
        isLoading: false,
        updateSettings,
      });
      const user = await openClaudeCodeTab();
      await user.click(screen.getByRole("switch", { name: /start in plan mode/i }));
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          claudeCode: expect.objectContaining({ startInPlanMode: true }),
        }),
      );
    });

    it("plan mode toggle is disabled when auto mode is off", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          claudeCode: { enableAutoMode: false, startInPlanMode: false },
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openClaudeCodeTab();
      expect(screen.getByRole("switch", { name: /start in plan mode/i })).toBeDisabled();
    });

    it("both toggles are disabled when claudeCodeAutoModeAvailable is false", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          claudeCodeAutoModeAvailable: false,
          claudeCodeAutoModeReason: "Claude Code version too old",
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openClaudeCodeTab();
      expect(screen.getByRole("switch", { name: /enable auto mode/i })).toBeDisabled();
      expect(screen.getByRole("switch", { name: /start in plan mode/i })).toBeDisabled();
      expect(screen.getByText("Claude Code version too old")).toBeInTheDocument();
    });

    it("toggling auto mode off also clears plan mode", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          claudeCode: { enableAutoMode: true, startInPlanMode: true },
        },
        isLoading: false,
        updateSettings,
      });
      const user = await openClaudeCodeTab();
      await user.click(screen.getByRole("switch", { name: /enable auto mode/i }));
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          claudeCode: { enableAutoMode: false, startInPlanMode: false },
        }),
      );
    });

    it("does not call updateSettings when settings is undefined", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: undefined,
        isLoading: true,
        updateSettings,
      });
      const user = await openClaudeCodeTab();
      await user.click(screen.getByRole("switch", { name: /enable auto mode/i }));
      expect(updateSettings).not.toHaveBeenCalled();
    });

    it("renders help text and documentation link", async () => {
      await openClaudeCodeTab();
      expect(
        screen.getByText(/auto mode lets claude code make changes autonomously/i),
      ).toBeInTheDocument();
      const link = screen.getByRole("link", {
        name: /learn about permission modes/i,
      });
      expect(link).toHaveAttribute(
        "href",
        "https://docs.anthropic.com/en/docs/claude-code/settings#permission-modes",
      );
    });

    it("renders help text when toggles are disabled", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          ...defaultSettings,
          claudeCodeAutoModeAvailable: false,
          claudeCodeAutoModeReason: "Claude Code version too old",
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openClaudeCodeTab();
      expect(
        screen.getByText(/auto mode lets claude code make changes autonomously/i),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("link", { name: /learn about permission modes/i }),
      ).toBeInTheDocument();
    });
  });
  describe("Blueprints tab — Duplicate action", () => {
    const blueprints: BlueprintMeta[] = [
      {
        id: "feature-dev",
        name: "Feature Dev",
        description: "Build features",
        icon: "code",
        source: "app",
      },
      {
        id: "review",
        name: "Code Review",
        description: "Review code",
        icon: "file-text",
        source: "app",
      },
    ];

    async function openBlueprintsTab() {
      const user = userEvent.setup();
      render();
      await user.click(screen.getByRole("tab", { name: "Blueprints" }));
      return user;
    }

    beforeEach(() => {
      mockedUseGlobalBlueprints.mockReturnValue({
        data: blueprints,
      } as ReturnType<typeof useGlobalBlueprints>);
    });

    it("renders a Duplicate button for each non-built-in blueprint", async () => {
      await openBlueprintsTab();
      const duplicateButtons = screen.getAllByRole("button", {
        name: /^Duplicate /i,
      });
      expect(duplicateButtons).toHaveLength(blueprints.length);
    });

    it("calls mutateAsync with the blueprint id when Duplicate is clicked", async () => {
      const mutateAsync = vi.fn().mockResolvedValue({
        id: "feature-dev-copy",
        name: "Feature Dev (copy)",
        description: "Build features",
        icon: "code",
        source: "app",
        content: "# Feature Dev",
        sizeBytes: 14,
        approxTokens: 4,
      });
      mockedUseDuplicateGlobalBlueprint.mockReturnValue({
        ...noopMutation,
        mutateAsync,
      } as unknown as ReturnType<typeof useDuplicateGlobalBlueprint>);

      const user = await openBlueprintsTab();
      // Wrap click + macrotask flush in a single act so that microtasks from
      // mutateAsync resolution fire within the React update boundary.
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Duplicate Feature Dev" }));
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(mutateAsync).toHaveBeenCalledWith({ id: "feature-dev" });
    });

    it("navigates to the edit route after successful duplication", async () => {
      const navigate = vi.fn();
      mockedUseNavigate.mockReturnValue(navigate);
      const mutateAsync = vi.fn().mockResolvedValue({
        id: "feature-dev-copy",
        name: "Feature Dev (copy)",
        description: "Build features",
        icon: "code",
        source: "app",
        content: "# Feature Dev",
        sizeBytes: 14,
        approxTokens: 4,
      });
      mockedUseDuplicateGlobalBlueprint.mockReturnValue({
        ...noopMutation,
        mutateAsync,
      } as unknown as ReturnType<typeof useDuplicateGlobalBlueprint>);

      const user = await openBlueprintsTab();
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Duplicate Feature Dev" }));
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(navigate).toHaveBeenCalledWith("/blueprints/edit/feature-dev-copy");
    });

    it("shows a toast and does not navigate when duplication fails with ApiError", async () => {
      const navigate = vi.fn();
      mockedUseNavigate.mockReturnValue(navigate);
      const addToast = vi.fn();
      mockedUseToast.mockReturnValue({ addToast, removeToast: vi.fn() });
      const mutateAsync = vi
        .fn()
        .mockRejectedValue(new ApiError("Name already exists", 409, "DUPLICATE_NAME"));
      mockedUseDuplicateGlobalBlueprint.mockReturnValue({
        ...noopMutation,
        mutateAsync,
      } as unknown as ReturnType<typeof useDuplicateGlobalBlueprint>);

      const user = await openBlueprintsTab();
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Duplicate Feature Dev" }));
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(addToast).toHaveBeenCalledWith("Name already exists");
      expect(navigate).not.toHaveBeenCalled();
    });

    it("shows a generic toast when duplication fails with a non-ApiError", async () => {
      const addToast = vi.fn();
      mockedUseToast.mockReturnValue({ addToast, removeToast: vi.fn() });
      const mutateAsync = vi.fn().mockRejectedValue(new Error("Network failure"));
      mockedUseDuplicateGlobalBlueprint.mockReturnValue({
        ...noopMutation,
        mutateAsync,
      } as unknown as ReturnType<typeof useDuplicateGlobalBlueprint>);

      const user = await openBlueprintsTab();
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Duplicate Feature Dev" }));
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(addToast).toHaveBeenCalledWith("Failed to duplicate blueprint.");
    });

    it("disables Duplicate buttons while a duplication is in progress", async () => {
      // isDuplicating is driven by duplicate.isPending from the mutation hook
      mockedUseDuplicateGlobalBlueprint.mockReturnValue({
        ...noopMutation,
        isPending: true,
      } as unknown as ReturnType<typeof useDuplicateGlobalBlueprint>);

      await openBlueprintsTab();

      const buttons = screen.getAllByRole("button", { name: /^Duplicate /i });
      for (const btn of buttons) {
        expect(btn).toBeDisabled();
      }
    });
  });
});
