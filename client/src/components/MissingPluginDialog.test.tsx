// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InstallPreview, PluginManifest, PluginRecord } from "@roubo/shared";
import { ApiError } from "../lib/api";
import ToastProvider from "./ToastProvider";

vi.mock("../hooks/usePlugins", () => ({
  useInstallPluginPreview: vi.fn(),
  useInstallPluginConfirm: vi.fn(),
  useInstallPluginCancel: vi.fn(),
}));

import MissingPluginDialog from "./MissingPluginDialog";
import {
  useInstallPluginPreview,
  useInstallPluginConfirm,
  useInstallPluginCancel,
} from "../hooks/usePlugins";

const mockPreview = vi.mocked(useInstallPluginPreview);
const mockConfirm = vi.mocked(useInstallPluginConfirm);
const mockCancel = vi.mocked(useInstallPluginCancel);

function fixtureManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "jira-self-hosted",
    name: "Jira (self-hosted)",
    version: "0.1.0",
    description: "Test fixture",
    kind: "integration",
    roubo: "^1.0.0",
    entry: "./index.js",
    permissions: {
      network: { hosts: [] },
      credentials: { slots: [] },
      filesystem: { paths: [] },
      processes: false,
    },
    ...overrides,
  } as PluginManifest;
}

function fixturePreview(overrides: Partial<InstallPreview> = {}): InstallPreview {
  return {
    stagingToken: "11111111-1111-1111-1111-111111111111",
    manifest: fixtureManifest(),
    source: { type: "git", url: "git@github.com:acme/roubo-jira-plugin.git" },
    ...overrides,
  };
}

function fixturePluginRecord(): PluginRecord {
  return {
    id: "jira-self-hosted",
    manifest: fixtureManifest(),
    manifestPath: "/p/jira/roubo-plugin.yaml",
    pluginDir: "/p/jira",
    source: "user",
    status: "enabled",
    lastError: null,
    restartHistory: [],
    pid: 4242,
  };
}

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

function renderDialog(
  props: Partial<React.ComponentProps<typeof MissingPluginDialog>> = {},
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const onClose = props.onClose ?? vi.fn();
  const onSkip = props.onSkip ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MissingPluginDialog
          projectId={props.projectId ?? "demo"}
          pluginId={props.pluginId ?? "jira-self-hosted"}
          pluginSource={props.pluginSource}
          onClose={onClose}
          onSkip={onSkip}
        />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...utils, onClose, onSkip, client };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("MissingPluginDialog", () => {
  describe("prompt step (pluginSource present)", () => {
    it("shows the heading, plugin id, and one-click install button (TC-028)", () => {
      setupMutations();
      renderDialog({ pluginSource: "git@github.com:acme/roubo-jira-plugin.git" });

      expect(
        screen.getByRole("heading", { name: /Plugin needed for this project/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("jira-self-hosted")).toBeInTheDocument();
      expect(screen.getByTestId("missing-plugin-suggested-source")).toHaveTextContent(
        "git@github.com:acme/roubo-jira-plugin.git",
      );
      expect(screen.getByTestId("missing-plugin-one-click-install")).toBeInTheDocument();
    });

    it("one-click install calls preview with source=git and advances to permissions (TC-028)", async () => {
      const user = userEvent.setup();
      const { previewMutate } = setupMutations({
        previewMutate: (_body, callbacks) => {
          callbacks.onSuccess?.(fixturePreview());
        },
      });
      renderDialog({ pluginSource: "git@github.com:acme/roubo-jira-plugin.git" });

      await user.click(screen.getByTestId("missing-plugin-one-click-install"));

      expect(previewMutate).toHaveBeenCalledWith(
        { source: "git", value: "git@github.com:acme/roubo-jira-plugin.git" },
        expect.any(Object),
      );
      expect(
        await screen.findByRole("heading", { name: /Install Jira \(self-hosted\)/i }),
      ).toBeInTheDocument();
    });

    it("detects local-path pluginSource and submits source=local", async () => {
      const user = userEvent.setup();
      const { previewMutate } = setupMutations({
        previewMutate: (_body, callbacks) => {
          callbacks.onSuccess?.(
            fixturePreview({ source: { type: "local", path: "/Users/x/dev/plugin" } }),
          );
        },
      });
      renderDialog({ pluginSource: "/Users/x/dev/plugin" });

      await user.click(screen.getByTestId("missing-plugin-one-click-install"));

      expect(previewMutate).toHaveBeenCalledWith(
        { source: "local", value: "/Users/x/dev/plugin" },
        expect.any(Object),
      );
    });

    it("confirming the install invalidates project-integration and closes (TC-028)", async () => {
      const user = userEvent.setup();
      setupMutations({
        previewMutate: (_body, callbacks) => {
          callbacks.onSuccess?.(fixturePreview());
        },
        confirmMutate: (_token, callbacks) => {
          callbacks.onSuccess?.({ plugin: fixturePluginRecord() });
        },
      });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const invalidateSpy = vi.spyOn(client, "invalidateQueries");
      const { onClose } = renderDialog(
        {
          projectId: "demo",
          pluginSource: "git@github.com:acme/roubo-jira-plugin.git",
        },
        client,
      );

      await user.click(screen.getByTestId("missing-plugin-one-click-install"));
      await user.click(await screen.findByTestId("install-plugin-confirm"));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["project-integration", "demo"],
      });
    });

    it("when pluginSource clone fails, shows the error and offers manual source entry (TC-066)", async () => {
      const user = userEvent.setup();
      setupMutations({
        previewMutate: (_body, callbacks) => {
          callbacks.onError?.(
            new ApiError(
              "Could not clone repository. git exited with code 128: Repository not found.",
              400,
              "clone-failed",
            ),
          );
        },
      });
      renderDialog({ pluginSource: "git@github.com:acme/roubo-jira-plugin.git" });

      await user.click(screen.getByTestId("missing-plugin-one-click-install"));

      const banner = await screen.findByTestId("missing-plugin-error");
      expect(banner).toHaveTextContent(/git exited with code 128/);
      expect(banner).toHaveTextContent(/Repository not found/);

      await user.click(screen.getByTestId("missing-plugin-use-different-source"));
      expect(screen.getByTestId("install-plugin-git-url")).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: /local directory/i })).toBeInTheDocument();
    });

    it("Skip for now fires onSkip", async () => {
      const user = userEvent.setup();
      setupMutations();
      const { onSkip } = renderDialog({
        pluginSource: "git@github.com:acme/roubo-jira-plugin.git",
      });

      await user.click(screen.getByTestId("missing-plugin-skip"));
      expect(onSkip).toHaveBeenCalled();
    });
  });

  describe("source step (no pluginSource hint)", () => {
    it("renders the SourceScreen immediately when pluginSource is undefined", () => {
      setupMutations();
      renderDialog({ pluginSource: undefined });
      expect(screen.getByTestId("install-plugin-git-url")).toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: /Plugin needed for this project/i }),
      ).toBeInTheDocument();
    });

    it("submits a manually-entered Git URL via the preview mutation", async () => {
      const user = userEvent.setup();
      const { previewMutate } = setupMutations({
        previewMutate: (_body, callbacks) => {
          callbacks.onSuccess?.(fixturePreview());
        },
      });
      renderDialog({ pluginSource: undefined });

      await user.type(
        screen.getByTestId("install-plugin-git-url"),
        "https://github.com/manual/plugin.git",
      );
      await user.click(screen.getByTestId("install-plugin-submit"));

      expect(previewMutate).toHaveBeenCalledWith(
        { source: "git", value: "https://github.com/manual/plugin.git" },
        expect.any(Object),
      );
    });

    it("Skip for now (rendered as Cancel on the source screen) fires onSkip", async () => {
      const user = userEvent.setup();
      setupMutations();
      const { onSkip } = renderDialog({ pluginSource: undefined });

      await user.click(screen.getByRole("button", { name: /Skip for now/i }));
      expect(onSkip).toHaveBeenCalled();
    });
  });
});
