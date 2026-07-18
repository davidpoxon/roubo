// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, DialogTrigger } from "react-aria-components";
import { renderWithProviders } from "../test/renderWithProviders";
import SwitchIntegrationDialog from "./SwitchIntegrationDialog";
import { useInstalledPlugins } from "../hooks/useInstalledPlugins";
import {
  useSwitchProjectIntegration,
  usePromoteProjectIntegration,
} from "../hooks/useProjectIntegration";

function renderDialog(props: { currentPluginId: string | null; onClose?: () => void }) {
  const onClose = props.onClose ?? vi.fn();
  return renderWithProviders(
    <DialogTrigger
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Button>Switch integration</Button>
      <SwitchIntegrationDialog projectId="demo" currentPluginId={props.currentPluginId} />
    </DialogTrigger>,
  );
}

vi.mock("../hooks/useInstalledPlugins", () => ({
  useInstalledPlugins: vi.fn(),
}));

vi.mock("../hooks/useProjectIntegration", () => ({
  useSwitchProjectIntegration: vi.fn(),
  usePromoteProjectIntegration: vi.fn(),
}));

const mockedUseInstalledPlugins = vi.mocked(useInstalledPlugins);
const mockedUseSwitchProjectIntegration = vi.mocked(useSwitchProjectIntegration);
const mockedUsePromoteProjectIntegration = vi.mocked(usePromoteProjectIntegration);

const mutateAsync = vi.fn();
const promoteMutateAsync = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync.mockResolvedValue(undefined);
  promoteMutateAsync.mockResolvedValue(undefined);
  mockedUseSwitchProjectIntegration.mockReturnValue({
    mutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useSwitchProjectIntegration>);
  mockedUsePromoteProjectIntegration.mockReturnValue({
    mutateAsync: promoteMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof usePromoteProjectIntegration>);
  mockedUseInstalledPlugins.mockReturnValue({
    data: [
      { id: "github-com", name: "GitHub.com", status: "enabled" },
      { id: "jira-self-hosted", name: "Jira", status: "enabled" },
    ],
    isLoading: false,
  } as unknown as ReturnType<typeof useInstalledPlugins>);
});

describe("SwitchIntegrationDialog", () => {
  // Issue #612 / #424: React Aria omits aria-modal and strips the prop, so the
  // shared stampAriaModal ref is what makes the modality explicit to AT.
  it("stamps aria-modal on the dialog", () => {
    renderDialog({ currentPluginId: "github-com" });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("shows the bench-survival explanation when a current plugin is set", () => {
    renderDialog({ currentPluginId: "github-com" });

    expect(screen.getByRole("heading", { name: /Switch integration/i })).toBeInTheDocument();
    expect(
      screen.getByText(/Active benches will keep working against their stored issue snapshot/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /show an "Issue from previous integration" badge and their source-sync controls will be disabled/i,
      ),
    ).toBeInTheDocument();
  });

  it("renders 'Choose integration' title and hides bench-survival copy when no current plugin", () => {
    renderDialog({ currentPluginId: null });

    expect(screen.getByRole("heading", { name: /Choose integration/i })).toBeInTheDocument();
    expect(screen.queryByText(/Active benches will keep working/i)).not.toBeInTheDocument();
    // TC-164: the confirm button carries a stable testid so Playwright specs
    // can target it without colliding with the page-level "Choose integration"
    // trigger button, which shares the same accessible name.
    expect(screen.getByTestId("switch-integration-confirm")).toBeInTheDocument();
  });

  it("primary button is disabled until a different plugin is selected", async () => {
    const user = userEvent.setup();
    renderDialog({ currentPluginId: "github-com" });

    // Two buttons match /Switch integration/: the DialogTrigger button and the
    // confirm button. Use accessible name + role + position via getAllByRole.
    const buttons = screen.getAllByRole("button", { name: /Switch integration/i });
    // Last one is the dialog confirm button (the trigger button comes first in DOM).
    const primary = buttons[buttons.length - 1];
    expect(primary).toBeDisabled();

    await user.click(screen.getByRole("radio", { name: /Jira/i }));
    expect(primary).toBeEnabled();
  });

  it("calls mutateAsync with the chosen plugin id on confirm and closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDialog({ currentPluginId: "github-com", onClose });

    await user.click(screen.getByRole("radio", { name: /Jira/i }));
    const buttons = screen.getAllByRole("button", { name: /Switch integration/i });
    await user.click(buttons[buttons.length - 1]);

    expect(mutateAsync).toHaveBeenCalledWith("jira-self-hosted");
    expect(onClose).toHaveBeenCalled();
  });

  it("does not promote to roubo.yaml on confirm when the checkbox is left unchecked", async () => {
    const user = userEvent.setup();
    renderDialog({ currentPluginId: "github-com" });

    await user.click(screen.getByRole("radio", { name: /Jira/i }));
    const buttons = screen.getAllByRole("button", { name: /Switch integration/i });
    await user.click(buttons[buttons.length - 1]);

    expect(mutateAsync).toHaveBeenCalledWith("jira-self-hosted");
    expect(promoteMutateAsync).not.toHaveBeenCalled();
  });

  it("promotes to roubo.yaml after switching when the checkbox is checked", async () => {
    const user = userEvent.setup();
    renderDialog({ currentPluginId: "github-com" });

    await user.click(screen.getByRole("radio", { name: /Jira/i }));
    await user.click(screen.getByRole("checkbox", { name: /update this project's roubo\.yaml/i }));
    const buttons = screen.getAllByRole("button", { name: /Switch integration/i });
    await user.click(buttons[buttons.length - 1]);

    expect(mutateAsync).toHaveBeenCalledWith("jira-self-hosted");
    expect(promoteMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open and surfaces the error when the switch succeeds but promote fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    // Switch resolves; the best-effort promote rejects. The override is already
    // changed, so the dialog must not close and must show the failure inline.
    promoteMutateAsync.mockRejectedValueOnce(new Error("roubo.yaml is read-only"));
    renderDialog({ currentPluginId: "github-com", onClose });

    await user.click(screen.getByRole("radio", { name: /Jira/i }));
    await user.click(screen.getByRole("checkbox", { name: /update this project's roubo\.yaml/i }));
    const buttons = screen.getAllByRole("button", { name: /Switch integration/i });
    await user.click(buttons[buttons.length - 1]);

    expect(mutateAsync).toHaveBeenCalledWith("jira-self-hosted");
    expect(promoteMutateAsync).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("roubo.yaml is read-only");
  });

  it("disables radios for errored or incompatible plugins", () => {
    mockedUseInstalledPlugins.mockReturnValue({
      data: [
        { id: "github-com", name: "GitHub.com", status: "enabled" },
        { id: "broken", name: "Broken", status: "errored", lastError: "boom" },
        { id: "old", name: "Old", status: "incompatible" },
      ],
      isLoading: false,
    } as unknown as ReturnType<typeof useInstalledPlugins>);

    renderDialog({ currentPluginId: "github-com" });

    expect(screen.getByRole("radio", { name: /Broken/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Old/i })).toBeDisabled();
  });
});
