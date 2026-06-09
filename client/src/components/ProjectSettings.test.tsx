// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/renderWithProviders";
import ProjectSettings from "./ProjectSettings";
import type { JigMeta } from "@roubo/shared";
import { DEFAULT_JIG_SETTINGS, DEFAULT_CLAUDE_CODE_SETTINGS } from "@roubo/shared";

vi.mock("react-router-dom", () => ({
  useNavigate: vi.fn(),
  useLocation: vi.fn(() => ({ hash: "" })),
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

vi.mock("../hooks/useJigs", () => ({
  useGlobalJigs: vi.fn(),
  useDeleteGlobalJig: vi.fn(),
  useDuplicateGlobalJig: vi.fn(),
}));

vi.mock("../hooks/useToast", () => ({
  useToast: vi.fn(() => ({ addToast: vi.fn(), removeToast: vi.fn() })),
}));

vi.mock("./jig-editor/jigIcons", () => ({
  getJigIcon: () => () => null,
  JIG_ICONS: [],
  JIG_ICON_MAP: {},
  DEFAULT_JIG_ICON: "file-text",
}));

vi.mock("./jig-editor/DeleteJigDialog", () => ({
  default: () => null,
}));

vi.mock("./DirectoryPicker", () => ({
  default: ({ onChange }: { onChange: (val: string) => void }) => (
    <input data-testid="directory-picker" onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { useNavigate, useLocation } from "react-router-dom";
import { useSettings } from "../hooks/useSettings";
import { useGlobalJigs, useDeleteGlobalJig, useDuplicateGlobalJig } from "../hooks/useJigs";
import { useToast } from "../hooks/useToast";
import { ApiError } from "../lib/api";

const mockedUseNavigate = vi.mocked(useNavigate);
const mockedUseLocation = vi.mocked(useLocation);
const mockedUseSettings = vi.mocked(useSettings);
const mockedUseGlobalJigs = vi.mocked(useGlobalJigs);
const mockedUseDeleteGlobalJig = vi.mocked(useDeleteGlobalJig);
const mockedUseDuplicateGlobalJig = vi.mocked(useDuplicateGlobalJig);
const mockedUseToast = vi.mocked(useToast);

const defaultSettings = {
  theme: "dark" as const,
  jigs: DEFAULT_JIG_SETTINGS,
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
  mockedUseLocation.mockReturnValue({ hash: "" } as ReturnType<typeof useLocation>);
  mockedUseSettings.mockReturnValue({
    settings: defaultSettings,
    isLoading: false,
    updateSettings: vi.fn(),
  });
  mockedUseGlobalJigs.mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useGlobalJigs>);
  mockedUseDeleteGlobalJig.mockReturnValue(
    noopMutation as unknown as ReturnType<typeof useDeleteGlobalJig>,
  );
  mockedUseDuplicateGlobalJig.mockReturnValue(
    noopMutation as unknown as ReturnType<typeof useDuplicateGlobalJig>,
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

    it("WU-051 / TC-116: outer wrapper uses w-full with no max-w constraint", () => {
      render();
      // The Settings <h2> is the first child of the page wrapper, so walking
      // up one level gives us the wrapper element under test.
      const wrapper = screen.getByText("Settings").parentElement;
      if (!wrapper) throw new Error("Settings heading has no parent wrapper");
      expect(wrapper.className).toContain("w-full");
      expect(wrapper.className).not.toMatch(/\bmax-w-/);
    });

    it("renders all six tab labels", () => {
      render();
      expect(screen.getByRole("tab", { name: "Benches" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "TestBench" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Appearance" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Jigs" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Plugins" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Claude Code" })).toBeInTheDocument();
    });

    it("no longer renders the legacy Integrations tab", () => {
      render();
      expect(screen.queryByRole("tab", { name: "Integrations" })).toBeNull();
    });

    it("TC-010: top-level tab is labelled 'Benches', not 'Bench Defaults'", () => {
      render();
      expect(screen.getByRole("tab", { name: "Benches" })).toBeInTheDocument();
      expect(screen.queryByRole("tab", { name: "Bench Defaults" })).toBeNull();
    });

    it("defaults to the Benches tab", () => {
      render();
      expect(screen.getByRole("tab", { name: "Benches" })).toHaveAttribute("aria-selected", "true");
    });

    it("pre-selects the Plugins tab when the URL hash is #plugins", () => {
      mockedUseLocation.mockReturnValue({ hash: "#plugins" } as ReturnType<typeof useLocation>);
      render();
      expect(screen.getByRole("tab", { name: "Plugins" })).toHaveAttribute("aria-selected", "true");
    });

    it("ignores an unknown hash and falls back to the default tab", () => {
      mockedUseLocation.mockReturnValue({ hash: "#bogus" } as ReturnType<typeof useLocation>);
      render();
      expect(screen.getByRole("tab", { name: "Benches" })).toHaveAttribute("aria-selected", "true");
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
          jigs: DEFAULT_JIG_SETTINGS,
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

  describe("Jigs tab", () => {
    it("renders auto-inject toggle", async () => {
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Jigs" }));
      expect(screen.getByText("Auto-inject jig")).toBeInTheDocument();
    });

    it("renders auto-execute toggle", async () => {
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Jigs" }));
      expect(screen.getByText("Auto-execute")).toBeInTheDocument();
    });

    it("auto-execute is disabled when auto-inject is off", async () => {
      mockedUseSettings.mockReturnValue({
        settings: {
          theme: "dark",
          jigs: {
            autoInject: false,
            autoExecute: false,
            defaultJigId: "feature-dev",
          },
          claudeCodeAutoModeAvailable: true,
          contextWindow: 200_000,
        },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Jigs" }));

      // The auto-execute switch should be disabled
      const switches = screen.getAllByRole("switch");
      const autoExecuteSwitch = switches.find(
        (s) =>
          s.closest('[class*="opacity-40"]') !== null || s.getAttribute("aria-disabled") === "true",
      );
      expect(autoExecuteSwitch).toBeDefined();
    });

    it("renders jig options", async () => {
      const jigs: JigMeta[] = [
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
      mockedUseGlobalJigs.mockReturnValue({
        data: jigs,
      } as ReturnType<typeof useGlobalJigs>);
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Jigs" }));

      expect(screen.getAllByText("Feature Dev").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Code Review").length).toBeGreaterThanOrEqual(1);
    });

    it('renders "Inherit from global default" option in app default picker', async () => {
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Jigs" }));
      expect(screen.getByText("Inherit from global default")).toBeInTheDocument();
    });

    it('calls updateSettings with undefined defaultJigId when "Inherit from global default" is selected in app picker', async () => {
      const updateSettingsMock = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: {
          theme: "dark",
          jigs: {
            autoInject: true,
            autoExecute: true,
            defaultJigId: "some-bp",
          },
          claudeCodeAutoModeAvailable: true,
          contextWindow: 200_000,
        },
        isLoading: false,
        updateSettings: updateSettingsMock,
      });

      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Jigs" }));
      await user.click(screen.getByText("Inherit from global default"));

      expect(updateSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          jigs: expect.not.objectContaining({
            defaultJigId: expect.anything(),
          }),
        }),
      );
    });
  });

  describe("Jigs tab: interactions", () => {
    it("calls updateSettings when auto-inject toggle is clicked", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: defaultSettings,
        isLoading: false,
        updateSettings,
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Jigs" }));

      const switches = screen.getAllByRole("switch");
      const autoInjectSwitch = switches[0];
      await user.click(autoInjectSwitch);
      expect(updateSettings).toHaveBeenCalled();
    });

    it("calls updateSettings when a jig option is selected", async () => {
      const updateSettings = vi.fn();
      const jigs: JigMeta[] = [
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
      mockedUseGlobalJigs.mockReturnValue({
        data: jigs,
      } as ReturnType<typeof useGlobalJigs>);
      mockedUseSettings.mockReturnValue({
        settings: defaultSettings,
        isLoading: false,
        updateSettings,
      });
      render();
      const user = userEvent.setup();
      await user.click(screen.getByRole("tab", { name: "Jigs" }));

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
      await user.click(screen.getByRole("tab", { name: "Jigs" }));

      const switches = screen.getAllByRole("switch");
      await user.click(switches[0]);
      expect(updateSettings).not.toHaveBeenCalled();
    });
  });

  describe("Benches tab", () => {
    async function openBenchesTab() {
      const user = userEvent.setup();
      render();
      await user.click(screen.getByRole("tab", { name: "Benches" }));
      return user;
    }

    it("does not call updateSettings when settings is undefined", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: undefined,
        isLoading: true,
        updateSettings,
      });
      const user = await openBenchesTab();
      await user.click(screen.getByRole("switch", { name: /enforce issue dependencies/i }));
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
            enforceIssueDependencies: true,
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
            enforceIssueDependencies: false,
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
            enforceIssueDependencies: false,
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
            enforceIssueDependencies: true,
            autoStartComponents: false,
          },
        }),
      );
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
            enforceIssueDependencies: false,
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
            enforceIssueDependencies: false,
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
            enforceIssueDependencies: false,
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
            enforceIssueDependencies: false,
            autoStartComponents: true,
          },
        }),
      );
    });

    describe("Global bench limit", () => {
      const cappedSettings = (maxGlobal?: number) => ({
        ...defaultSettings,
        benches: {
          enforceIssueDependencies: false,
          autoStartComponents: false,
          ...(maxGlobal != null ? { maxGlobal } : {}),
        },
      });

      it("TC-011: renders Unlimited (selected) with a disabled numeric field by default", async () => {
        await openBenchesTab();
        expect(screen.getByRole("radio", { name: "Unlimited" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "Limit" })).not.toBeChecked();
        expect(screen.getByRole("textbox", { name: "Maximum benches" })).toBeDisabled();
      });

      it("TC-011: selecting Limit enables the field and prefills 5", async () => {
        const updateSettings = vi.fn();
        mockedUseSettings.mockReturnValue({
          settings: defaultSettings,
          isLoading: false,
          updateSettings,
        });
        const user = await openBenchesTab();
        await user.click(screen.getByRole("radio", { name: "Limit" }));
        const field = screen.getByRole("textbox", { name: "Maximum benches" });
        expect(field).toBeEnabled();
        expect(field).toHaveValue("5");
        expect(updateSettings.mock.calls.at(-1)?.[0].benches.maxGlobal).toBe(5);
      });

      it("renders Limit selected with the persisted value when a cap is set", async () => {
        mockedUseSettings.mockReturnValue({
          settings: cappedSettings(5),
          isLoading: false,
          updateSettings: vi.fn(),
        });
        await openBenchesTab();
        expect(screen.getByRole("radio", { name: "Limit" })).toBeChecked();
        const field = screen.getByRole("textbox", { name: "Maximum benches" });
        expect(field).toBeEnabled();
        expect(field).toHaveValue("5");
      });

      it("TC-031: selecting Unlimited removes the cap and clears the field", async () => {
        const updateSettings = vi.fn();
        mockedUseSettings.mockReturnValue({
          settings: cappedSettings(5),
          isLoading: false,
          updateSettings,
        });
        const user = await openBenchesTab();
        await user.click(screen.getByRole("radio", { name: "Unlimited" }));
        expect(updateSettings.mock.calls.at(-1)?.[0].benches.maxGlobal).toBeUndefined();
        const field = screen.getByRole("textbox", { name: "Maximum benches" });
        expect(field).toBeDisabled();
        expect(field).toHaveValue("");
      });

      it("persists a valid limit on blur", async () => {
        const updateSettings = vi.fn();
        mockedUseSettings.mockReturnValue({
          settings: cappedSettings(5),
          isLoading: false,
          updateSettings,
        });
        const user = await openBenchesTab();
        const field = screen.getByRole("textbox", { name: "Maximum benches" });
        await user.clear(field);
        await user.type(field, "7");
        await user.tab();
        expect(updateSettings.mock.calls.at(-1)?.[0].benches.maxGlobal).toBe(7);
      });

      it("shows inline validation and does not persist invalid input", async () => {
        const updateSettings = vi.fn();
        mockedUseSettings.mockReturnValue({
          settings: cappedSettings(5),
          isLoading: false,
          updateSettings,
        });
        const user = await openBenchesTab();
        const field = screen.getByRole("textbox", { name: "Maximum benches" });

        for (const bad of ["0", "-3", "1.5"]) {
          updateSettings.mockClear();
          await user.clear(field);
          await user.type(field, bad);
          await user.tab();
          expect(screen.getByRole("alert")).toHaveTextContent(/whole number of 1 or more/i);
          expect(updateSettings).not.toHaveBeenCalled();
        }

        // Empty while Limit is selected is also invalid.
        updateSettings.mockClear();
        await user.clear(field);
        await user.tab();
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(updateSettings).not.toHaveBeenCalled();
      });

      it("does not persist when settings has not loaded", async () => {
        const updateSettings = vi.fn();
        mockedUseSettings.mockReturnValue({
          settings: undefined,
          isLoading: true,
          updateSettings,
        });
        const user = await openBenchesTab();
        await user.click(screen.getByRole("radio", { name: "Limit" }));
        expect(updateSettings).not.toHaveBeenCalled();
      });
    });
  });

  describe("Appearance tab: null settings fallback", () => {
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
  describe("TestBench tab", () => {
    async function openTestBenchTab() {
      const user = userEvent.setup();
      render();
      await user.click(screen.getByRole("tab", { name: "TestBench" }));
      return user;
    }

    it("renders the enable TestBench toggle as a switch", async () => {
      await openTestBenchTab();
      expect(screen.getByRole("switch", { name: /enable testbench/i })).toBeInTheDocument();
    });

    it("toggle defaults to enabled when settings omit testBench (DEFAULT_TESTBENCH_SETTINGS)", async () => {
      await openTestBenchTab();
      expect(screen.getByRole("switch", { name: /enable testbench/i })).toBeChecked();
    });

    it("toggle is checked when testBench.enabled is true", async () => {
      mockedUseSettings.mockReturnValue({
        settings: { ...defaultSettings, testBench: { enabled: true } },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openTestBenchTab();
      expect(screen.getByRole("switch", { name: /enable testbench/i })).toBeChecked();
    });

    it("toggle is unchecked when testBench.enabled is false", async () => {
      mockedUseSettings.mockReturnValue({
        settings: { ...defaultSettings, testBench: { enabled: false } },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openTestBenchTab();
      expect(screen.getByRole("switch", { name: /enable testbench/i })).not.toBeChecked();
    });

    it("calls updateSettings with toggled value when clicked", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: { ...defaultSettings, testBench: { enabled: true } },
        isLoading: false,
        updateSettings,
      });
      const user = await openTestBenchTab();
      await user.click(screen.getByRole("switch", { name: /enable testbench/i }));
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ testBench: { enabled: false } }),
      );
    });

    it("shows the disabled helper text when off", async () => {
      mockedUseSettings.mockReturnValue({
        settings: { ...defaultSettings, testBench: { enabled: false } },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openTestBenchTab();
      expect(
        screen.getByText(
          "Disabled. The create-TestBench option and the TestBench surface are hidden.",
        ),
      ).toBeInTheDocument();
    });

    it("hides the disabled helper text when enabled", async () => {
      mockedUseSettings.mockReturnValue({
        settings: { ...defaultSettings, testBench: { enabled: true } },
        isLoading: false,
        updateSettings: vi.fn(),
      });
      await openTestBenchTab();
      expect(
        screen.queryByText(
          "Disabled. The create-TestBench option and the TestBench surface are hidden.",
        ),
      ).toBeNull();
    });

    it("does not call updateSettings when settings is undefined", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: undefined,
        isLoading: true,
        updateSettings,
      });
      const user = await openTestBenchTab();
      await user.click(screen.getByRole("switch", { name: /enable testbench/i }));
      expect(updateSettings).not.toHaveBeenCalled();
    });

    it("is keyboard operable: focusing and pressing Space toggles the switch", async () => {
      const updateSettings = vi.fn();
      mockedUseSettings.mockReturnValue({
        settings: { ...defaultSettings, testBench: { enabled: true } },
        isLoading: false,
        updateSettings,
      });
      const user = await openTestBenchTab();
      const toggle = screen.getByRole("switch", { name: /enable testbench/i });
      act(() => toggle.focus());
      expect(toggle).toHaveFocus();
      await user.keyboard("[Space]");
      expect(updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ testBench: { enabled: false } }),
      );
    });
  });

  describe("Jigs tab: Duplicate action", () => {
    const jigs: JigMeta[] = [
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

    async function openJigsTab() {
      const user = userEvent.setup();
      render();
      await user.click(screen.getByRole("tab", { name: "Jigs" }));
      return user;
    }

    beforeEach(() => {
      mockedUseGlobalJigs.mockReturnValue({
        data: jigs,
      } as ReturnType<typeof useGlobalJigs>);
    });

    it("renders a Duplicate button for each non-built-in jig", async () => {
      await openJigsTab();
      const duplicateButtons = screen.getAllByRole("button", {
        name: /^Duplicate /i,
      });
      expect(duplicateButtons).toHaveLength(jigs.length);
    });

    it("calls mutateAsync with the jig id when Duplicate is clicked", async () => {
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
      mockedUseDuplicateGlobalJig.mockReturnValue({
        ...noopMutation,
        mutateAsync,
      } as unknown as ReturnType<typeof useDuplicateGlobalJig>);

      const user = await openJigsTab();
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
      mockedUseDuplicateGlobalJig.mockReturnValue({
        ...noopMutation,
        mutateAsync,
      } as unknown as ReturnType<typeof useDuplicateGlobalJig>);

      const user = await openJigsTab();
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Duplicate Feature Dev" }));
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(navigate).toHaveBeenCalledWith("/jigs/edit/feature-dev-copy");
    });

    it("shows a toast and does not navigate when duplication fails with ApiError", async () => {
      const navigate = vi.fn();
      mockedUseNavigate.mockReturnValue(navigate);
      const addToast = vi.fn();
      mockedUseToast.mockReturnValue({ addToast, removeToast: vi.fn() });
      const mutateAsync = vi
        .fn()
        .mockRejectedValue(new ApiError("Name already exists", 409, "DUPLICATE_NAME"));
      mockedUseDuplicateGlobalJig.mockReturnValue({
        ...noopMutation,
        mutateAsync,
      } as unknown as ReturnType<typeof useDuplicateGlobalJig>);

      const user = await openJigsTab();
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
      mockedUseDuplicateGlobalJig.mockReturnValue({
        ...noopMutation,
        mutateAsync,
      } as unknown as ReturnType<typeof useDuplicateGlobalJig>);

      const user = await openJigsTab();
      await act(async () => {
        await user.click(screen.getByRole("button", { name: "Duplicate Feature Dev" }));
        await new Promise((r) => setTimeout(r, 0));
      });

      expect(addToast).toHaveBeenCalledWith("Failed to duplicate jig.");
    });

    it("disables Duplicate buttons while a duplication is in progress", async () => {
      // isDuplicating is driven by duplicate.isPending from the mutation hook
      mockedUseDuplicateGlobalJig.mockReturnValue({
        ...noopMutation,
        isPending: true,
      } as unknown as ReturnType<typeof useDuplicateGlobalJig>);

      await openJigsTab();

      const buttons = screen.getAllByRole("button", { name: /^Duplicate /i });
      for (const btn of buttons) {
        expect(btn).toBeDisabled();
      }
    });
  });
});
