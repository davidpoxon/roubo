// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  InstallPreview,
  MissingPluginResolution,
  PluginManifest,
  PluginRecord,
} from "@roubo/shared";
import { ApiError } from "../lib/api";
import ToastProvider from "./ToastProvider";

vi.mock("../hooks/usePlugins", () => ({
  useInstallPluginPreview: vi.fn(),
  useInstallPluginConfirm: vi.fn(),
  useInstallPluginCancel: vi.fn(),
}));

vi.mock("../hooks/useMarketplace", () => ({
  useMarketplaceInstallPreview: vi.fn(),
}));

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));

import MissingPluginDialog from "./MissingPluginDialog";
import {
  useInstallPluginPreview,
  useInstallPluginConfirm,
  useInstallPluginCancel,
} from "../hooks/usePlugins";
import { useMarketplaceInstallPreview } from "../hooks/useMarketplace";

const mockPreview = vi.mocked(useInstallPluginPreview);
const mockConfirm = vi.mocked(useInstallPluginConfirm);
const mockCancel = vi.mocked(useInstallPluginCancel);
const mockMarketplacePreview = vi.mocked(useMarketplaceInstallPreview);

const ACME_ID = "marketplace-acme-example-1a2b3c4d";
const FIRST_PARTY = "roubo-first-party";

/** Exactly one registered source serves the id: the AC1 shape. */
function singleSource(): MissingPluginResolution {
  return {
    pluginId: "google-clasp",
    state: "single-source",
    source: { sourceId: ACME_ID, label: "ACME workplace", registered: true },
  };
}

/** Two sources serve the id: the AC2 pick-a-source shape. */
function ambiguous(): MissingPluginResolution {
  return {
    pluginId: "process",
    state: "ambiguous",
    sources: [
      { sourceId: FIRST_PARTY, label: "Roubo first-party", registered: false },
      { sourceId: ACME_ID, label: "ACME workplace", registered: true },
    ],
  };
}

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
  // The marketplace-source install path (issue #566): takes { id, sourceId }
  // rather than a Git URL / local path.
  marketplacePreviewMutate?: (
    vars: { id: string; sourceId?: string },
    callbacks: { onSuccess?: (data: InstallPreview) => void; onError?: (err: unknown) => void },
  ) => void;
}) {
  const previewMutate = vi.fn().mockImplementation(opts?.previewMutate ?? (() => {}));
  const confirmMutate = vi.fn().mockImplementation(opts?.confirmMutate ?? (() => {}));
  const cancelMutate = vi.fn().mockImplementation(opts?.cancelMutate ?? (() => {}));
  const marketplacePreviewMutate = vi
    .fn()
    .mockImplementation(opts?.marketplacePreviewMutate ?? (() => {}));

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
  mockMarketplacePreview.mockReturnValue({
    mutate: marketplacePreviewMutate,
    isPending: false,
  } as unknown as ReturnType<typeof useMarketplaceInstallPreview>);

  return { previewMutate, confirmMutate, cancelMutate, marketplacePreviewMutate };
}

function renderDialog(
  props: Partial<React.ComponentProps<typeof MissingPluginDialog>> = {},
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const onClose = props.onClose ?? vi.fn();
  const onSkip = props.onSkip ?? vi.fn();
  const onInstalled = props.onInstalled ?? vi.fn();
  const utils = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MissingPluginDialog
            projectId={props.projectId ?? "demo"}
            pluginId={props.pluginId ?? "jira-self-hosted"}
            pluginSource={props.pluginSource}
            resolution={props.resolution}
            componentName={props.componentName}
            onClose={onClose}
            onSkip={onSkip}
            onInstalled={onInstalled}
          />
        </ToastProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { ...utils, onClose, onSkip, onInstalled, client };
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

  // Issue #566 (CPHMTP-FR-008 / CPHMTP-US-002): a bound component plugin the
  // marketplace can resolve gets an actionable error. This is a DIFFERENT install
  // path from the Git-URL prompt above: it names a marketplace sourceId.
  describe("marketplace-resolved missing plugin (issue #566)", () => {
    // CPHMTP-TC-077 S002-O01 (AC1): both actions are present for one source.
    it("offers install-from-<source> and view-in-marketplace for a single source", () => {
      setupMutations();
      renderDialog({ resolution: singleSource(), componentName: "apps-script" });

      expect(
        screen.getByRole("button", { name: /Install from ACME workplace/i }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /View in marketplace/i })).toBeInTheDocument();
      // The component whose binding pulled the plugin in is named, so the error is
      // traceable back to the roubo.yaml that caused it.
      expect(screen.getByText("apps-script")).toBeInTheDocument();
      expect(screen.getByText("google-clasp")).toBeInTheDocument();
    });

    it("marks a registered source as registered (TC-077 S001-O01)", () => {
      setupMutations();
      renderDialog({ resolution: singleSource(), componentName: "apps-script" });
      expect(screen.getByText("registered")).toBeInTheDocument();
    });

    // CPHMTP-TC-077 S003-O01: the install names the source explicitly, which is
    // what keeps it honest under the FR-005 no-precedence rule.
    it("installs from the named source, passing its sourceId", async () => {
      const user = userEvent.setup();
      const { marketplacePreviewMutate } = setupMutations();
      renderDialog({ resolution: singleSource(), componentName: "apps-script" });

      await user.click(screen.getByRole("button", { name: /Install from ACME workplace/i }));
      expect(marketplacePreviewMutate).toHaveBeenCalledWith(
        { id: "google-clasp", sourceId: ACME_ID },
        expect.anything(),
      );
    });

    // CPHMTP-TC-077 S003-O02 (AC1): completing the install resumes what it blocked.
    it("fires onInstalled after the install is committed, so bench start resumes", async () => {
      const user = userEvent.setup();
      setupMutations({
        marketplacePreviewMutate: (_vars, cb) => cb.onSuccess?.(fixturePreview()),
        confirmMutate: (_token, cb) => cb.onSuccess?.({ plugin: fixturePluginRecord() }),
      });
      const { onInstalled } = renderDialog({
        resolution: singleSource(),
        componentName: "apps-script",
      });

      await user.click(screen.getByRole("button", { name: /Install from ACME workplace/i }));
      // The consent step is shared with every other install path; confirming it is
      // what commits, and only then may the blocked start resume.
      await user.click(await screen.findByRole("button", { name: /Install|Confirm/i }));
      await waitFor(() => expect(onInstalled).toHaveBeenCalled());
    });

    // CPHMTP-TC-081 S002-O01 (AC2): two sources render one action EACH and no
    // single primary. Nothing here may pick a source for the consumer.
    it("renders one install action per source when the id is ambiguous", () => {
      setupMutations();
      renderDialog({ resolution: ambiguous(), componentName: "backend" });

      expect(
        screen.getByRole("button", { name: /Install from Roubo first-party/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Install from ACME workplace/i }),
      ).toBeInTheDocument();
      expect(screen.getByText(/pick the one to install from/i)).toBeInTheDocument();
    });

    it("installs from whichever source the consumer picked (TC-081 S002)", async () => {
      const user = userEvent.setup();
      const { marketplacePreviewMutate } = setupMutations();
      renderDialog({ resolution: ambiguous(), componentName: "backend" });

      await user.click(screen.getByRole("button", { name: /Install from ACME workplace/i }));
      expect(marketplacePreviewMutate).toHaveBeenCalledWith(
        { id: "process", sourceId: ACME_ID },
        expect.anything(),
      );
    });

    // Progress belongs to the source the consumer actually pressed. A shared
    // pending flag would relabel EVERY source's button, which in a pick-a-source
    // list erases the very choice the consumer just made (CPHMTP-FR-005).
    it("shows progress only on the source the consumer pressed", async () => {
      const user = userEvent.setup();
      // A mutate that never settles leaves the install in flight, so the pressed
      // source stays pending for the assertions below.
      setupMutations({ marketplacePreviewMutate: () => {} });
      renderDialog({ resolution: ambiguous(), componentName: "backend" });

      await user.click(screen.getByRole("button", { name: /Install from ACME workplace/i }));

      expect(screen.getByRole("button", { name: /Inspecting/i })).toHaveAttribute(
        "data-testid",
        `missing-plugin-install-from-${ACME_ID}`,
      );
      expect(
        screen.getByRole("button", { name: /Install from Roubo first-party/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Install from ACME workplace/i }),
      ).not.toBeInTheDocument();
    });

    it("navigates to the marketplace and closes on view-in-marketplace", async () => {
      const user = userEvent.setup();
      setupMutations();
      const { onClose } = renderDialog({ resolution: singleSource() });

      await user.click(screen.getByRole("button", { name: /View in marketplace/i }));
      expect(navigateSpy).toHaveBeenCalledWith("/settings#marketplace");
      expect(onClose).toHaveBeenCalled();
    });

    it("surfaces a failed marketplace install without leaving the source screen", async () => {
      const user = userEvent.setup();
      setupMutations({
        marketplacePreviewMutate: (_vars, cb) =>
          cb.onError?.(new ApiError("Source is unreachable", 503, "marketplace-unreachable")),
      });
      renderDialog({ resolution: singleSource() });

      await user.click(screen.getByRole("button", { name: /Install from ACME workplace/i }));
      expect(await screen.findByTestId("missing-plugin-error")).toHaveTextContent(
        "Source is unreachable",
      );
      // Still actionable: the consumer can retry the same source.
      expect(
        screen.getByRole("button", { name: /Install from ACME workplace/i }),
      ).toBeInTheDocument();
    });

    // One source's failure must not read as another's. Each row in the
    // pick-a-source list is its own trust decision, so a stale error beside a
    // different source's in-flight install actively misinforms it.
    it("clears a failed source's error when a different source is picked", async () => {
      const user = userEvent.setup();
      let failNext = true;
      setupMutations({
        // Only the first press fails; the second is left in flight, so any error
        // still on screen afterwards can only be the stale one from press one.
        marketplacePreviewMutate: (_vars, cb) => {
          if (failNext) {
            failNext = false;
            cb.onError?.(new ApiError("Source is unreachable", 503, "marketplace-unreachable"));
          }
        },
      });
      renderDialog({ resolution: ambiguous(), componentName: "backend" });

      await user.click(screen.getByRole("button", { name: /Install from ACME workplace/i }));
      expect(await screen.findByTestId("missing-plugin-error")).toHaveTextContent(
        "Source is unreachable",
      );

      await user.click(screen.getByRole("button", { name: /Install from Roubo first-party/i }));
      expect(screen.queryByTestId("missing-plugin-error")).not.toBeInTheDocument();
    });

    // The Git-URL affordances belong to the project-integration path only: a
    // marketplace-resolved plugin has no suggested Git source to offer.
    it("does not offer the Git-URL prompt affordances", () => {
      setupMutations();
      renderDialog({ resolution: singleSource() });

      expect(screen.queryByTestId("missing-plugin-one-click-install")).not.toBeInTheDocument();
      expect(screen.queryByTestId("missing-plugin-use-different-source")).not.toBeInTheDocument();
    });
  });
});
