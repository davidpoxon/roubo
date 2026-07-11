// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InstallPreview, PermissionCategory, PluginError } from "@roubo/shared";

vi.mock("../../../hooks/usePlugins");
vi.mock("../../../hooks/useMarketplace");
vi.mock("../../../hooks/useToast");

// Stub the consent modal so the banner tests stay focused on the Reinstall
// affordance and its wiring, not the modal's internals (which have their own
// coverage). The stub captures the props the banner hands it so the confirm /
// cancel handlers can be exercised.
let lastConsentProps: {
  mode: string;
  error: string | null;
  onConfirm: (categories: PermissionCategory[]) => void;
  onCancel: () => void;
} | null = null;
vi.mock("../../marketplace/MarketplaceConsentModal", () => ({
  default: (props: {
    mode: string;
    error: string | null;
    onConfirm: (categories: PermissionCategory[]) => void;
    onCancel: () => void;
  }) => {
    lastConsentProps = props;
    return (
      <div
        data-testid="marketplace-consent-modal"
        data-mode={props.mode}
        data-error={props.error ?? ""}
      />
    );
  },
}));

import { useGrantConsent, useRestartPlugin } from "../../../hooks/usePlugins";
import {
  useMarketplaceInstallCancel,
  useMarketplaceInstallConfirm,
  useMarketplaceUpdatePreview,
} from "../../../hooks/useMarketplace";
import { useToast } from "../../../hooks/useToast";
import ErroredBanner from "./ErroredBanner";

const mockedUseRestart = vi.mocked(useRestartPlugin);
const mockedUseGrantConsent = vi.mocked(useGrantConsent);
const mockedUseUpdatePreview = vi.mocked(useMarketplaceUpdatePreview);
const mockedUseInstallConfirm = vi.mocked(useMarketplaceInstallConfirm);
const mockedUseInstallCancel = vi.mocked(useMarketplaceInstallCancel);
const mockedUseToast = vi.mocked(useToast);

const missingEntryError: PluginError = {
  code: "missing-entry",
  message:
    "Plugin entry file not found: ./dist/index.js. The plugin may not be built; reinstall it from the marketplace.",
};

const fakePreview = {
  stagingToken: "tok-123",
  manifest: { id: "my-component", name: "My Component" },
  source: { type: "release", assetUrl: "https://example.test/a.tgz" },
} as unknown as InstallPreview;

interface Handles {
  restartMutate: ReturnType<typeof vi.fn>;
  updateMutate: ReturnType<typeof vi.fn>;
  confirmMutate: ReturnType<typeof vi.fn>;
  cancelMutate: ReturnType<typeof vi.fn>;
  grantMutate: ReturnType<typeof vi.fn>;
  addToast: ReturnType<typeof vi.fn>;
}

function setup(
  overrides: { restartPending?: boolean; updatePending?: boolean; confirmPending?: boolean } = {},
): Handles {
  const restartMutate = vi.fn();
  const updateMutate = vi.fn();
  const confirmMutate = vi.fn();
  const cancelMutate = vi.fn();
  const grantMutate = vi.fn();
  const addToast = vi.fn();
  mockedUseRestart.mockReturnValue({
    mutate: restartMutate,
    isPending: overrides.restartPending ?? false,
  } as unknown as ReturnType<typeof useRestartPlugin>);
  mockedUseGrantConsent.mockReturnValue({
    mutate: grantMutate,
  } as unknown as ReturnType<typeof useGrantConsent>);
  mockedUseUpdatePreview.mockReturnValue({
    mutate: updateMutate,
    isPending: overrides.updatePending ?? false,
  } as unknown as ReturnType<typeof useMarketplaceUpdatePreview>);
  mockedUseInstallConfirm.mockReturnValue({
    mutate: confirmMutate,
    isPending: overrides.confirmPending ?? false,
  } as unknown as ReturnType<typeof useMarketplaceInstallConfirm>);
  mockedUseInstallCancel.mockReturnValue({
    mutate: cancelMutate,
  } as unknown as ReturnType<typeof useMarketplaceInstallCancel>);
  mockedUseToast.mockReturnValue({ addToast } as unknown as ReturnType<typeof useToast>);
  return { restartMutate, updateMutate, confirmMutate, cancelMutate, grantMutate, addToast };
}

describe("ErroredBanner (issue #302)", () => {
  beforeEach(() => {
    lastConsentProps = null;
    setup();
  });

  it("shows the real lastError code + message for an errored component plugin and omits the snapshot line", () => {
    render(
      <ErroredBanner
        pluginId="my-component"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    const banner = screen.getByTestId("plugin-errored-banner");
    expect(banner.textContent).toContain("missing-entry");
    expect(banner.textContent).toContain("Plugin entry file not found: ./dist/index.js");
    expect(banner.textContent).toContain("reinstall it from the marketplace");
    // Component plugins have no cached-snapshot fallback, so that line is hidden.
    expect(banner.textContent).not.toContain("last successful issue snapshot");
    // The old hardcoded restart copy must not appear for a non-restart error.
    expect(banner.textContent).not.toContain("3 restart attempts");
  });

  it("shows the real lastError and the snapshot line for an errored integration plugin", () => {
    render(
      <ErroredBanner
        pluginId="github-com"
        lastError={{
          code: "restart-budget-exhausted",
          message: "Plugin failed to start after 3 restart attempts.",
        }}
        kind="integration"
        onViewLogs={() => {}}
      />,
    );
    const banner = screen.getByTestId("plugin-errored-banner");
    expect(banner.textContent).toContain("restart-budget-exhausted");
    // The "3 restart attempts" wording is the plugin's own message here, i.e. an
    // actual restart-budget exhaustion, not banner-hardcoded copy.
    expect(banner.textContent).toContain("Plugin failed to start after 3 restart attempts");
    expect(banner.textContent).toContain("last successful issue snapshot");
  });

  it("renders a long, multi-line message in full without dropping content", () => {
    const longMessage =
      "Plugin failed to load its manifest.\n" +
      "The declared entry point could not be resolved after several attempts, ".repeat(4) +
      "and the host gave up.";
    render(
      <ErroredBanner
        pluginId="big-plugin"
        lastError={{ code: "manifest-load-failed", message: longMessage }}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    const banner = screen.getByTestId("plugin-errored-banner");
    expect(banner.textContent).toContain("Plugin failed to load its manifest.");
    expect(banner.textContent).toContain("and the host gave up.");
  });

  it("falls back to a generic message when lastError is null", () => {
    render(
      <ErroredBanner
        pluginId="github-com"
        lastError={null}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    const banner = screen.getByTestId("plugin-errored-banner");
    expect(banner.textContent).toContain("Plugin failed to start.");
    expect(banner.textContent).not.toContain("3 restart attempts");
  });

  it("calls restart mutation when Restart is pressed", async () => {
    const user = userEvent.setup();
    const { restartMutate } = setup();
    render(
      <ErroredBanner
        pluginId="github-com"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restart" }));
    expect(restartMutate).toHaveBeenCalledWith("github-com");
  });

  it("calls onViewLogs when View logs is pressed", async () => {
    const user = userEvent.setup();
    const onViewLogs = vi.fn();
    render(
      <ErroredBanner
        pluginId="github-com"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={onViewLogs}
      />,
    );
    await user.click(screen.getByRole("button", { name: "View logs" }));
    expect(onViewLogs).toHaveBeenCalled();
  });

  it("disables Restart and shows pending label while pending", () => {
    setup({ restartPending: true });
    render(
      <ErroredBanner
        pluginId="github-com"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    const btn = screen.getByRole("button", { name: "Restarting..." });
    expect(btn).toBeDisabled();
  });
});

describe("ErroredBanner Reinstall affordance (issue #496)", () => {
  beforeEach(() => {
    lastConsentProps = null;
    setup();
  });

  it("exposes a Reinstall action for an errored component plugin", () => {
    render(
      <ErroredBanner
        pluginId="my-component"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    expect(screen.getByTestId("plugin-reinstall-action")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reinstall" })).toBeInTheDocument();
    // The recovery pair (Reinstall + View logs) is present.
    expect(screen.getByRole("button", { name: "View logs" })).toBeInTheDocument();
  });

  it("does not expose a Reinstall action for a non-component (integration) plugin", () => {
    render(
      <ErroredBanner
        pluginId="github-com"
        lastError={missingEntryError}
        kind="integration"
        onViewLogs={() => {}}
      />,
    );
    expect(screen.queryByTestId("plugin-reinstall-action")).not.toBeInTheDocument();
  });

  it("initiates the marketplace update-preview for the plugin id when Reinstall is pressed", async () => {
    const user = userEvent.setup();
    const { updateMutate } = setup();
    render(
      <ErroredBanner
        pluginId="my-component"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    await user.click(screen.getByTestId("plugin-reinstall-action"));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0][0]).toBe("my-component");
  });

  it("surfaces the consent dialog once the update-preview is staged", async () => {
    const user = userEvent.setup();
    const { updateMutate } = setup();
    updateMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (preview: InstallPreview) => void }) => {
        opts.onSuccess(fakePreview);
      },
    );
    render(
      <ErroredBanner
        pluginId="my-component"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    await user.click(screen.getByTestId("plugin-reinstall-action"));
    const modal = screen.getByTestId("marketplace-consent-modal");
    expect(modal).toBeInTheDocument();
    // The reinstall reuses the marketplace "update" flow.
    expect(modal).toHaveAttribute("data-mode", "update");
  });

  it("toasts and shows no dialog when the update-preview staging fails", async () => {
    const user = userEvent.setup();
    const { updateMutate, addToast } = setup();
    updateMutate.mockImplementation((_id: string, opts: { onError: (err: unknown) => void }) => {
      opts.onError(new Error("catalog offline"));
    });
    render(
      <ErroredBanner
        pluginId="my-component"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    await user.click(screen.getByTestId("plugin-reinstall-action"));
    expect(addToast).toHaveBeenCalledWith("catalog offline");
    expect(screen.queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
  });

  it("commits the reinstall and grants consent when the consent dialog confirms", async () => {
    const user = userEvent.setup();
    const { updateMutate, confirmMutate, grantMutate, addToast } = setup();
    updateMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (preview: InstallPreview) => void }) => {
        opts.onSuccess(fakePreview);
      },
    );
    confirmMutate.mockImplementation((_token: string, opts: { onSuccess: () => void }) => {
      opts.onSuccess();
    });
    render(
      <ErroredBanner
        pluginId="my-component"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    await user.click(screen.getByTestId("plugin-reinstall-action"));
    expect(lastConsentProps).not.toBeNull();
    act(() => {
      lastConsentProps?.onConfirm(["network"] as PermissionCategory[]);
    });
    expect(confirmMutate.mock.calls[0][0]).toBe("tok-123");
    expect(grantMutate).toHaveBeenCalledWith({
      pluginId: "my-component",
      acknowledgedCategories: ["network"],
    });
    expect(addToast).toHaveBeenCalledWith("Reinstalled My Component.");
    // The dialog closes after a successful commit.
    expect(screen.queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
  });

  it("surfaces the commit error in the dialog when confirming the reinstall fails", async () => {
    const user = userEvent.setup();
    const { updateMutate, confirmMutate, addToast } = setup();
    updateMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (preview: InstallPreview) => void }) => {
        opts.onSuccess(fakePreview);
      },
    );
    confirmMutate.mockImplementation(
      (_token: string, opts: { onError: (err: unknown) => void }) => {
        opts.onError(new Error("digest mismatch"));
      },
    );
    render(
      <ErroredBanner
        pluginId="my-component"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    await user.click(screen.getByTestId("plugin-reinstall-action"));
    act(() => {
      lastConsentProps?.onConfirm([] as PermissionCategory[]);
    });
    // The dialog stays open and carries the commit error (no toast for this path).
    const modal = screen.getByTestId("marketplace-consent-modal");
    expect(modal).toHaveAttribute("data-error", "digest mismatch");
    expect(addToast).not.toHaveBeenCalled();
  });

  it("cancels the staged reinstall and closes the dialog when the consent dialog cancels", async () => {
    const user = userEvent.setup();
    const { updateMutate, cancelMutate } = setup();
    updateMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (preview: InstallPreview) => void }) => {
        opts.onSuccess(fakePreview);
      },
    );
    render(
      <ErroredBanner
        pluginId="my-component"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    await user.click(screen.getByTestId("plugin-reinstall-action"));
    expect(screen.getByTestId("marketplace-consent-modal")).toBeInTheDocument();
    act(() => {
      lastConsentProps?.onCancel();
    });
    expect(cancelMutate).toHaveBeenCalledWith("tok-123");
    expect(screen.queryByTestId("marketplace-consent-modal")).not.toBeInTheDocument();
  });

  it("shows the pending label and disables Reinstall while the update-preview is staging", () => {
    setup({ updatePending: true });
    render(
      <ErroredBanner
        pluginId="my-component"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    const btn = screen.getByRole("button", { name: "Reinstalling..." });
    expect(btn).toBeDisabled();
  });
});
