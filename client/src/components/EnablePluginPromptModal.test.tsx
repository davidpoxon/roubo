// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/renderWithProviders";
import EnablePluginPromptModal from "./EnablePluginPromptModal";

vi.mock("../lib/api");
import * as api from "../lib/api";

// The shared useEnablePlugin hook routes failures through a global toast in
// addition to surfacing them to the caller. Stub the toast context so the hook
// can render outside a ToastProvider; we assert inline-error behaviour below.
vi.mock("../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn() }),
}));

const mockedApi = vi.mocked(api);

function renderModal(
  overrides: Partial<React.ComponentProps<typeof EnablePluginPromptModal>> = {},
) {
  const props: React.ComponentProps<typeof EnablePluginPromptModal> = {
    projectId: "proj-1",
    pluginId: "github-com",
    pluginName: "GitHub.com",
    onCancel: vi.fn(),
    onEnabled: vi.fn(),
    ...overrides,
  };
  return { ...renderWithProviders(<EnablePluginPromptModal {...props} />), props };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("EnablePluginPromptModal", () => {
  it("renders the prompt with the plugin name and id (TC-120)", () => {
    renderModal();
    expect(
      screen.getByRole("heading", { name: /Enable GitHub\.com to load this project\?/i }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("enable-plugin-modal")).toBeInTheDocument();
    expect(screen.getByTestId("enable-plugin-cancel")).toBeInTheDocument();
    expect(screen.getByTestId("enable-plugin-confirm")).toBeInTheDocument();
  });

  it("focuses the primary confirm button on open (TC-152)", () => {
    renderModal();
    expect(screen.getByTestId("enable-plugin-confirm")).toHaveFocus();
  });

  it("Enter on the focused primary button confirms (TC-152)", async () => {
    const user = userEvent.setup();
    mockedApi.enablePlugin.mockResolvedValue(undefined);
    const onEnabled = vi.fn();
    renderModal({ onEnabled });

    expect(screen.getByTestId("enable-plugin-confirm")).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(mockedApi.enablePlugin).toHaveBeenCalledWith("github-com");
    await waitFor(() => expect(onEnabled).toHaveBeenCalled());
  });

  it("Esc cancels without calling the enable RPC (TC-152, TC-121)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderModal({ onCancel });

    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalled();
    expect(mockedApi.enablePlugin).not.toHaveBeenCalled();
  });

  it("Cancel click triggers onCancel and does not call enable (TC-121)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    renderModal({ onCancel });

    await user.click(screen.getByTestId("enable-plugin-cancel"));

    expect(onCancel).toHaveBeenCalled();
    expect(mockedApi.enablePlugin).not.toHaveBeenCalled();
  });

  it("calls enablePlugin on confirm and signals onEnabled on success", async () => {
    const user = userEvent.setup();
    mockedApi.enablePlugin.mockResolvedValue(undefined);
    const onEnabled = vi.fn();
    renderModal({ onEnabled });

    await user.click(screen.getByTestId("enable-plugin-confirm"));

    await waitFor(() => expect(mockedApi.enablePlugin).toHaveBeenCalledWith("github-com"));
    await waitFor(() => expect(onEnabled).toHaveBeenCalled());
  });

  it("displays an inline error on enable failure and keeps the modal open (TC-154)", async () => {
    const user = userEvent.setup();
    mockedApi.enablePlugin.mockRejectedValue(new Error("plugin process refused to start"));
    const onEnabled = vi.fn();
    const onCancel = vi.fn();
    renderModal({ onEnabled, onCancel });

    await user.click(screen.getByTestId("enable-plugin-confirm"));

    const errorBlock = await screen.findByTestId("enable-plugin-error");
    expect(errorBlock).toHaveTextContent(/plugin process refused to start/);
    expect(onEnabled).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    // Modal is still mounted with its buttons available for retry.
    expect(screen.getByTestId("enable-plugin-modal")).toBeInTheDocument();
    expect(screen.getByTestId("enable-plugin-confirm")).toBeEnabled();
  });

  it("uses a friendly fallback message when the error has no message body", async () => {
    const user = userEvent.setup();
    mockedApi.enablePlugin.mockRejectedValue("something opaque");
    renderModal({ pluginName: "GitHub.com" });

    await user.click(screen.getByTestId("enable-plugin-confirm"));

    const errorBlock = await screen.findByTestId("enable-plugin-error");
    expect(errorBlock).toHaveTextContent(/Couldn't start GitHub\.com/);
  });

  it("clears any prior error when the user retries", async () => {
    const user = userEvent.setup();
    mockedApi.enablePlugin
      .mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce(undefined);
    const onEnabled = vi.fn();
    renderModal({ onEnabled });

    await user.click(screen.getByTestId("enable-plugin-confirm"));
    await screen.findByTestId("enable-plugin-error");

    await user.click(screen.getByTestId("enable-plugin-confirm"));
    await waitFor(() => expect(onEnabled).toHaveBeenCalled());
    expect(screen.queryByTestId("enable-plugin-error")).toBeNull();
  });

  // Issue #612 / #424: React Aria omits aria-modal and strips the prop, so the
  // shared stampAriaModal ref is what makes the modality explicit to AT.
  it("stamps aria-modal on the dialog", () => {
    renderModal();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });
});
