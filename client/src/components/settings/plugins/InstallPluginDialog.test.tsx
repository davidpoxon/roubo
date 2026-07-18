// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, DialogTrigger } from "react-aria-components";
import type { InstallPreview, PluginManifest, PluginRecord } from "@roubo/shared";
import { ApiError } from "../../../lib/api";
import ToastProvider from "../../ToastProvider";

vi.mock("../../../hooks/usePlugins", () => ({
  useInstallPluginPreview: vi.fn(),
  useInstallPluginConfirm: vi.fn(),
  useInstallPluginCancel: vi.fn(),
}));

import InstallPluginDialog from "./InstallPluginDialog";
import {
  useInstallPluginPreview,
  useInstallPluginConfirm,
  useInstallPluginCancel,
} from "../../../hooks/usePlugins";

const mockPreview = vi.mocked(useInstallPluginPreview);
const mockConfirm = vi.mocked(useInstallPluginConfirm);
const mockCancel = vi.mocked(useInstallPluginCancel);

function setupMutations(opts?: {
  previewMutate?: (
    body: { source: "git" | "local"; value: string },
    callbacks: { onSuccess?: (data: InstallPreview) => void; onError?: (err: unknown) => void },
  ) => void;
  confirmMutate?: (
    token: string,
    callbacks: {
      onSuccess?: (data: { plugin: PluginRecord }) => void;
      onError?: (err: unknown) => void;
    },
  ) => void;
  cancelMutate?: (token: string) => void;
}) {
  const previewMutate = vi.fn().mockImplementation(opts?.previewMutate ?? (() => {}));
  const confirmMutate = vi.fn().mockImplementation(opts?.confirmMutate ?? (() => {}));
  const cancelMutate = vi.fn().mockImplementation(opts?.cancelMutate ?? (() => {}));

  mockPreview.mockReturnValue({
    mutate: previewMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useInstallPluginPreview>);
  mockConfirm.mockReturnValue({
    mutate: confirmMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useInstallPluginConfirm>);
  mockCancel.mockReturnValue({
    mutate: cancelMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useInstallPluginCancel>);

  return { previewMutate, confirmMutate, cancelMutate };
}

function fixtureManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "echo",
    name: "Echo",
    version: "1.2.3",
    description: "Test fixture",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "./index.js",
    permissions: {
      network: { hosts: ["api.example.com/*"] },
      credentials: {
        slots: [{ slot: "token", scope: "read", description: "API token used to query issues" }],
      },
      filesystem: { paths: ["~/.config/echo"] },
      processes: false,
    },
    ...overrides,
  } as PluginManifest;
}

function fixturePreview(overrides: Partial<InstallPreview> = {}): InstallPreview {
  return {
    stagingToken: "11111111-1111-1111-1111-111111111111",
    manifest: fixtureManifest(),
    source: { type: "git", url: "https://github.com/example/echo.git" },
    ...overrides,
  };
}

function fixturePluginRecord(): PluginRecord {
  return {
    id: "echo",
    manifest: fixtureManifest(),
    manifestPath: "/p/echo/roubo-plugin.yaml",
    pluginDir: "/p/echo",
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 1234,
  };
}

function renderDialog(onClose = vi.fn()) {
  return render(
    <ToastProvider>
      <DialogTrigger
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <Button>Install plugin</Button>
        <InstallPluginDialog />
      </DialogTrigger>
    </ToastProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("source step", () => {
  it("renders the Git URL tab selected by default with the install button visible", () => {
    setupMutations();
    renderDialog();
    expect(screen.getByRole("dialog", { name: /install plugin/i })).toBeInTheDocument();
    expect(screen.getByTestId("install-plugin-git-url")).toBeInTheDocument();
    expect(screen.getByTestId("install-plugin-submit")).toBeInTheDocument();
  });

  // Issue #612 / #424: React Aria omits aria-modal and strips the prop, so the
  // shared stampAriaModal ref is what makes the modality explicit to AT.
  it("stamps aria-modal on the dialog", () => {
    setupMutations();
    renderDialog();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("validates that the Git URL field is not empty", async () => {
    const user = userEvent.setup();
    const { previewMutate } = setupMutations();
    renderDialog();

    await user.click(screen.getByTestId("install-plugin-submit"));
    expect(previewMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("install-plugin-error")).toHaveTextContent(/enter the git url/i);
  });

  it("switches to the local tab and validates the path field", async () => {
    const user = userEvent.setup();
    const { previewMutate } = setupMutations();
    renderDialog();

    await user.click(screen.getByRole("tab", { name: /local directory/i }));
    expect(screen.getByTestId("install-plugin-local-path")).toBeInTheDocument();

    await user.click(screen.getByTestId("install-plugin-submit"));
    expect(previewMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("install-plugin-error")).toHaveTextContent(
      /enter the absolute path/i,
    );
  });

  it("calls previewInstallPlugin with source=git on submit (TC-007)", async () => {
    const user = userEvent.setup();
    const { previewMutate } = setupMutations({
      previewMutate: (body, callbacks) => {
        callbacks.onSuccess?.(fixturePreview());
      },
    });
    renderDialog();

    await user.type(
      screen.getByTestId("install-plugin-git-url"),
      "https://github.com/example/echo.git",
    );
    await user.click(screen.getByTestId("install-plugin-submit"));

    expect(previewMutate).toHaveBeenCalledWith(
      { source: "git", value: "https://github.com/example/echo.git" },
      expect.any(Object),
    );
    expect(
      await screen.findByRole("heading", { name: /install echo 1\.2\.3/i }),
    ).toBeInTheDocument();
  });

  it("calls previewInstallPlugin with source=local from the local tab (TC-019)", async () => {
    const user = userEvent.setup();
    const { previewMutate } = setupMutations({
      previewMutate: (_body, callbacks) => {
        callbacks.onSuccess?.(
          fixturePreview({ source: { type: "local", path: "/tmp/my-plugin" } }),
        );
      },
    });
    renderDialog();

    await user.click(screen.getByRole("tab", { name: /local directory/i }));
    await user.type(screen.getByTestId("install-plugin-local-path"), "/tmp/my-plugin");
    await user.click(screen.getByTestId("install-plugin-submit"));

    expect(previewMutate).toHaveBeenCalledWith(
      { source: "local", value: "/tmp/my-plugin" },
      expect.any(Object),
    );
    expect(await screen.findByText("/tmp/my-plugin", { exact: false })).toBeInTheDocument();
  });

  it("renders the server error message verbatim in a red banner (TC-058)", async () => {
    const user = userEvent.setup();
    const apiError = new ApiError(
      "Could not clone repository. git exited with code 128: Repository not found.",
      400,
      "clone-failed",
    );
    setupMutations({
      previewMutate: (_body, callbacks) => {
        callbacks.onError?.(apiError);
      },
    });
    renderDialog();

    await user.type(
      screen.getByTestId("install-plugin-git-url"),
      "https://github.com/missing/missing.git",
    );
    await user.click(screen.getByTestId("install-plugin-submit"));

    const banner = await screen.findByTestId("install-plugin-error");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent(/git exited with code 128/);
    expect(banner).toHaveTextContent(/Repository not found/);
  });

  it("shows the missing-manifest message for the local flow (TC-059)", async () => {
    const user = userEvent.setup();
    const apiError = new ApiError(
      "No roubo-plugin.yaml found in /tmp/empty-dir",
      400,
      "missing-manifest",
    );
    setupMutations({
      previewMutate: (_body, callbacks) => {
        callbacks.onError?.(apiError);
      },
    });
    renderDialog();

    await user.click(screen.getByRole("tab", { name: /local directory/i }));
    await user.type(screen.getByTestId("install-plugin-local-path"), "/tmp/empty-dir");
    await user.click(screen.getByTestId("install-plugin-submit"));

    const banner = await screen.findByTestId("install-plugin-error");
    expect(banner).toHaveTextContent(/no roubo-plugin\.yaml found/i);
    expect(banner).toHaveTextContent("/tmp/empty-dir");
  });
});

describe("permissions step", () => {
  function arrangePermissionsStep() {
    const onClose = vi.fn();
    const handles = setupMutations({
      previewMutate: (_body, callbacks) => {
        callbacks.onSuccess?.(fixturePreview());
      },
    });
    renderDialog(onClose);
    return { onClose, ...handles };
  }

  it("lists every declared permission category (TC-007, TC-075 ARIA wiring)", async () => {
    const user = userEvent.setup();
    arrangePermissionsStep();

    await user.type(
      screen.getByTestId("install-plugin-git-url"),
      "https://github.com/example/echo.git",
    );
    await user.click(screen.getByTestId("install-plugin-submit"));

    // Section headings; each is associated with its <section> via aria-labelledby
    // so screen readers announce each category individually (TC-075).
    expect(await screen.findByRole("region", { name: /network hosts/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /credentials/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /filesystem paths/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /child processes/i })).toBeInTheDocument();

    expect(screen.getByText("api.example.com/*")).toBeInTheDocument();
    expect(screen.getByText("token")).toBeInTheDocument();
    expect(screen.getByText("~/.config/echo")).toBeInTheDocument();

    // Source is shown.
    expect(screen.getByText(/git url/i)).toBeInTheDocument();
    expect(screen.getByText("https://github.com/example/echo.git")).toBeInTheDocument();

    // Primary action and cancel are clearly identified by accessible name (TC-075).
    expect(screen.getByRole("button", { name: /install and enable/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();

    // Dialog itself exposes role="dialog" and is named from the Heading (TC-075).
    expect(screen.getByRole("dialog", { name: /install echo/i })).toBeInTheDocument();
  });

  it("calls confirm on Install and enable; closes dialog and toasts (TC-007)", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const previewMutate = vi.fn().mockImplementation((_body, callbacks) => {
      callbacks.onSuccess?.(fixturePreview());
    });
    const confirmMutate = vi.fn().mockImplementation((_token, callbacks) => {
      callbacks.onSuccess?.({ plugin: fixturePluginRecord() });
    });
    mockPreview.mockReturnValue({
      mutate: previewMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useInstallPluginPreview>);
    mockConfirm.mockReturnValue({
      mutate: confirmMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useInstallPluginConfirm>);
    mockCancel.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useInstallPluginCancel>);

    render(
      <ToastProvider>
        <DialogTrigger
          isOpen
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
        >
          <Button>Install plugin</Button>
          <InstallPluginDialog />
        </DialogTrigger>
      </ToastProvider>,
    );

    await user.type(
      screen.getByTestId("install-plugin-git-url"),
      "https://github.com/example/echo.git",
    );
    await user.click(screen.getByTestId("install-plugin-submit"));
    await user.click(await screen.findByTestId("install-plugin-confirm"));

    expect(confirmMutate).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      expect.any(Object),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("Cancel on the permissions screen fires cancelInstallPlugin (no orphan staging)", async () => {
    const user = userEvent.setup();
    const { cancelMutate, onClose } = arrangePermissionsStep();

    await user.type(
      screen.getByTestId("install-plugin-git-url"),
      "https://github.com/example/echo.git",
    );
    await user.click(screen.getByTestId("install-plugin-submit"));
    await user.click(await screen.findByTestId("install-plugin-permissions-cancel"));

    expect(cancelMutate).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(onClose).toHaveBeenCalled();
  });
});
