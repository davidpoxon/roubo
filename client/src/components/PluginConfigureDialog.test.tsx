// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, DialogTrigger } from "react-aria-components";
import type { IntegrationConfig, ProjectIntegrationState } from "@roubo/shared";
import { renderWithProviders } from "../test/renderWithProviders";
import { ApiError } from "../lib/api";
import PluginConfigureDialog from "./PluginConfigureDialog";
import {
  useTestIntegrationConnection,
  useSaveIntegrationConfig,
  useSourceCandidates,
} from "../hooks/useProjectIntegration";
import { useIntegrationFields, useSaveIntegrationFields } from "../hooks/useIntegrationFields";
import { useDerivedGithubSources } from "../hooks/useDerivedGithubSources";
import {
  useTestGlobalPluginIntegration,
  useSaveGlobalPluginIntegration,
} from "../hooks/useGlobalPluginIntegration";

vi.mock("../hooks/useProjectIntegration", () => ({
  useTestIntegrationConnection: vi.fn(),
  useSaveIntegrationConfig: vi.fn(),
  useSourceCandidates: vi.fn(() => ({ data: undefined, isLoading: false })),
  useSaveIntegrationSources: vi.fn(() => ({ mutateAsync: vi.fn(), isPending: false })),
}));

vi.mock("../hooks/useIntegrationFields", () => ({
  useIntegrationFields: vi.fn(),
  useSaveIntegrationFields: vi.fn(),
}));

vi.mock("../hooks/useDerivedGithubSources", () => ({
  useDerivedGithubSources: vi.fn(),
}));

vi.mock("../hooks/useGlobalPluginIntegration", () => ({
  useTestGlobalPluginIntegration: vi.fn(),
  useSaveGlobalPluginIntegration: vi.fn(),
  useGlobalPluginIntegration: vi.fn(),
}));

const { useOpportunisticRecheckOnMountMock, useConnectionStatusMock } = vi.hoisted(() => {
  type UseConnectionStatusReturn = ReturnType<
    typeof import("../hooks/usePlugins").useConnectionStatus
  >;
  // Default to a "connected" pill so the modal body renders for tests that
  // exercise the form. Tests that need to assert disconnected state can
  // override with mockReturnValue.
  const useConnectionStatusMock = vi.fn<() => UseConnectionStatusReturn>(
    () =>
      ({
        data: { state: "connected", checkedAt: "2026-05-22T09:00:00.000Z" },
        isFetching: false,
      }) as unknown as UseConnectionStatusReturn,
  );
  return {
    useOpportunisticRecheckOnMountMock: vi.fn(),
    useConnectionStatusMock,
  };
});
vi.mock("../hooks/usePlugins", async () => {
  const actual = await vi.importActual<typeof import("../hooks/usePlugins")>("../hooks/usePlugins");
  return {
    ...actual,
    useOpportunisticRecheckOnMount: useOpportunisticRecheckOnMountMock,
    useConnectionStatus: useConnectionStatusMock,
  };
});

const { mockStartGithubPluginOauth, mockDisconnectGithubPluginOauth } = vi.hoisted(() => ({
  mockStartGithubPluginOauth: vi.fn(),
  mockDisconnectGithubPluginOauth: vi.fn(),
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    startGithubPluginOauth: mockStartGithubPluginOauth,
    disconnectGithubPluginOauth: mockDisconnectGithubPluginOauth,
  };
});

const mockedUseTest = vi.mocked(useTestIntegrationConnection);
const mockedUseSave = vi.mocked(useSaveIntegrationConfig);
const mockedUseFields = vi.mocked(useIntegrationFields);
const mockedUseSaveFields = vi.mocked(useSaveIntegrationFields);
const mockedUseDerivedSources = vi.mocked(useDerivedGithubSources);
const mockedUseSourceCandidates = vi.mocked(useSourceCandidates);

function inputIn(testId: string): HTMLInputElement {
  const wrapper = screen.getByTestId(testId);
  const input = wrapper.querySelector("input");
  if (!input) throw new Error(`No <input> inside ${testId}`);
  return input as HTMLInputElement;
}

type Plugin = NonNullable<ProjectIntegrationState["plugin"]>;

function makePlugin(overrides: Partial<Plugin["manifest"]> = {}): Plugin {
  return {
    id: "ghe",
    installed: true,
    status: "enabled",
    manifest: {
      name: "GitHub Enterprise",
      configSchema: {
        type: "object",
        properties: {
          instance: { type: "string", title: "Instance URL" },
          token: { type: "string", format: "password", title: "Personal access token" },
          allowSelfSignedTls: { type: "boolean", title: "Allow self-signed TLS" },
        },
      },
      permissions: {
        network: { hosts: [] },
        credentials: {
          slots: [{ slot: "token", scope: "read", description: "PAT used for API calls" }],
        },
        filesystem: { paths: [] },
        processes: false,
      },
      ...overrides,
    },
  };
}

function renderDialog({
  plugin = makePlugin(),
  effective = { plugin: "ghe" } as IntegrationConfig,
  onClose = vi.fn(),
}: {
  plugin?: Plugin;
  effective?: IntegrationConfig;
  onClose?: () => void;
} = {}) {
  return renderWithProviders(
    <DialogTrigger
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Button>Configure</Button>
      <PluginConfigureDialog
        scope="project"
        projectId="demo"
        plugin={plugin}
        effective={effective}
      />
    </DialogTrigger>,
  );
}

function installMocks(opts: {
  test: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  testPending?: boolean;
  savePending?: boolean;
  connectionState?: "connected" | "auth-problem" | "disconnected" | "errored";
  account?: { login: string };
}) {
  const connState = opts.connectionState ?? "connected";
  useConnectionStatusMock.mockImplementation(
    () =>
      ({
        data: {
          state: connState,
          checkedAt: "2026-05-22T09:00:00.000Z",
          ...(opts.account ? { account: opts.account } : {}),
        },
        isFetching: false,
      }) as unknown as UseConnectionStatusReturn,
  );
  mockedUseTest.mockReturnValue({
    mutateAsync: opts.test,
    isPending: opts.testPending ?? false,
  } as unknown as ReturnType<typeof useTestIntegrationConnection>);
  mockedUseSave.mockReturnValue({
    mutateAsync: opts.save,
    isPending: opts.savePending ?? false,
  } as unknown as ReturnType<typeof useSaveIntegrationConfig>);
  mockedUseFields.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useIntegrationFields>);
  mockedUseSaveFields.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  } as unknown as ReturnType<typeof useSaveIntegrationFields>);
  mockedUseDerivedSources.mockReturnValue({
    data: { repos: [], projects: [], alertsRequested: [] },
    isLoading: false,
  } as unknown as ReturnType<typeof useDerivedGithubSources>);
}

type UseConnectionStatusReturn = ReturnType<
  typeof import("../hooks/usePlugins").useConnectionStatus
>;
const CONNECTED_PILL = {
  data: { state: "connected", checkedAt: "2026-05-22T09:00:00.000Z" },
  isFetching: false,
} as unknown as UseConnectionStatusReturn;

beforeEach(() => {
  vi.clearAllMocks();
  // The hook fires on every render and may be queried multiple times per
  // mount; `mockReturnValueOnce` would be consumed by the first call and
  // leave subsequent calls undefined. Reset the persistent default so each
  // test starts from "connected" and can override with `mockReturnValue`.
  useConnectionStatusMock.mockImplementation(() => CONNECTED_PILL);
});

describe("PluginConfigureDialog", () => {
  it("renders the connection-status chip in the dialog header (WU-064, TC-168)", () => {
    installMocks({ test: vi.fn(), save: vi.fn() });
    renderDialog();
    const header = screen.getByTestId("plugin-configure-dialog-header");
    expect(header).toBeInTheDocument();
    const pill = screen.getByTestId("connection-status-pill");
    expect(pill).toHaveAttribute("data-state", "connected");
  });

  it("renders the declarative source picker for a non-GitHub plugin when connected (FR-019)", () => {
    installMocks({ test: vi.fn(), save: vi.fn() });
    mockedUseSourceCandidates.mockReturnValue({
      data: {
        shape: "categorized-multi-list",
        categories: [
          { id: "boards", label: "Boards", items: [{ externalId: "999", label: "PROJ Board" }] },
          { id: "epics", label: "Epics", items: [] },
          { id: "filters", label: "Filters", items: [] },
        ],
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useSourceCandidates>);

    const jira: Plugin = {
      id: "jira-self-hosted",
      installed: true,
      status: "enabled",
      manifest: {
        name: "Self-hosted Jira",
        configSchema: {
          type: "object",
          properties: { instance: { type: "string", title: "Instance URL" } },
        },
        permissions: {
          network: { hosts: ["**"] },
          credentials: { slots: [] },
          filesystem: { paths: [] },
          processes: false,
        },
      },
    };

    renderDialog({ plugin: jira, effective: { plugin: "jira-self-hosted" } as IntegrationConfig });

    expect(screen.getByTestId("source-picker")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Boards/ })).toBeInTheDocument();
  });

  it("does not render the source picker for the GitHub family (uses derived sources)", () => {
    installMocks({ test: vi.fn(), save: vi.fn() });
    // makePlugin() defaults to the GHE plugin, which derives sources from the repo.
    renderDialog();
    expect(screen.queryByTestId("source-picker")).not.toBeInTheDocument();
  });

  it("hides the form body and the Verify button when an OAuth plugin is not connected", () => {
    // The connection gate only applies to OAuth-driven plugins (github-com),
    // where credentials are bootstrapped via the dedicated GithubOauthSection.
    // Non-OAuth plugins keep the form visible so the user can enter creds.
    const githubPlugin: Plugin = {
      id: "github-com",
      installed: true,
      status: "enabled",
      manifest: {
        name: "GitHub",
        configSchema: { type: "object", properties: {} },
        permissions: {
          network: { hosts: [] },
          credentials: { slots: [] },
          filesystem: { paths: [] },
          processes: false,
        },
      },
    };
    installMocks({ test: vi.fn(), save: vi.fn(), connectionState: "auth-problem" });
    renderDialog({ plugin: githubPlugin, effective: { plugin: "github-com" } });
    // Verify button only renders when connected.
    expect(screen.queryByTestId("test-connection")).not.toBeInTheDocument();
    // Save is disabled while disconnected.
    expect(screen.getByTestId("save-config")).toBeDisabled();
  });

  it("keeps the form and Verify button visible for non-OAuth plugins even when disconnected", () => {
    // Without this, ghe / jira-self-hosted users have no path to enter the
    // credentials needed to reach `connected` on first install or after an
    // expiry.
    installMocks({ test: vi.fn(), save: vi.fn(), connectionState: "disconnected" });
    renderDialog();
    expect(screen.getByTestId("config-field-instance")).toBeInTheDocument();
    expect(screen.getByTestId("test-connection")).toBeInTheDocument();
    expect(screen.getByTestId("save-config")).not.toBeDisabled();
  });

  it("enables Save and exposes Verify the moment the connection-status pill reads 'connected'", () => {
    installMocks({ test: vi.fn(), save: vi.fn() });
    renderDialog();
    expect(screen.getByTestId("test-connection")).toBeInTheDocument();
    expect(screen.getByTestId("save-config")).not.toBeDisabled();
  });

  it("Save runs Verify implicitly, persists capturedUserId, and closes the dialog", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-42", displayName: "Jane Doe" },
    });
    const save = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    installMocks({ test, save });

    renderDialog({
      effective: { plugin: "ghe", instance: "https://ghe.acme.com" },
      onClose,
    });

    await user.click(screen.getByTestId("save-config"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const payload = save.mock.calls[0][0];
    expect(payload.capturedUserId).toEqual({ externalId: "u-42", displayName: "Jane Doe" });
    expect(payload.instance).toBe("https://ghe.acme.com");
    // Password fields MUST NOT be in the YAML payload (NFR-002).
    expect(payload.token).toBeUndefined();
    expect(payload.advanced?.token).toBeUndefined();
    expect(onClose).toHaveBeenCalled();
  });

  describe("status-category exclusion (issue #435)", () => {
    const verifyOk = () => vi.fn().mockResolvedValue({ ok: true, identity: { externalId: "u-1" } });
    const jiraPlugin = () =>
      makePlugin({
        name: "Jira",
        configSchema: { type: "object", properties: { instance: { type: "string" } } },
        defaultIntegrationConfig: { excludedStatusCategories: ["Done"] },
      });

    it("renders the canonical categories with the manifest default checked", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      renderDialog({ plugin: jiraPlugin(), effective: { plugin: "jira-self-hosted" } });

      expect(screen.getByTestId("status-exclusion-section")).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Done" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "To Do" })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: "In Progress" })).not.toBeChecked();
    });

    it("seeds the checked state from the effective override (empty = exclude nothing)", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      renderDialog({
        plugin: jiraPlugin(),
        effective: { plugin: "jira-self-hosted", excludedStatusCategories: [] },
      });

      expect(screen.getByRole("checkbox", { name: "Done" })).not.toBeChecked();
    });

    it("does not render the section for a plugin without category-exclusion support", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      renderDialog();

      expect(screen.queryByTestId("status-exclusion-section")).not.toBeInTheDocument();
    });

    it("persists the edited set on Save when changed", async () => {
      const user = userEvent.setup();
      const save = vi.fn().mockResolvedValue({});
      installMocks({ test: verifyOk(), save });
      renderDialog({
        plugin: jiraPlugin(),
        effective: { plugin: "jira-self-hosted", instance: "https://jira.acme.com" },
      });

      await user.click(screen.getByRole("checkbox", { name: "In Progress" }));
      await user.click(screen.getByTestId("save-config"));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

      expect(save.mock.calls[0][0].excludedStatusCategories).toEqual(["Done", "In Progress"]);
    });

    it("persists an empty set when the user clears every category", async () => {
      const user = userEvent.setup();
      const save = vi.fn().mockResolvedValue({});
      installMocks({ test: verifyOk(), save });
      renderDialog({
        plugin: jiraPlugin(),
        effective: { plugin: "jira-self-hosted", instance: "https://jira.acme.com" },
      });

      await user.click(screen.getByRole("checkbox", { name: "Done" }));
      await user.click(screen.getByTestId("save-config"));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

      expect(save.mock.calls[0][0].excludedStatusCategories).toEqual([]);
    });

    it("omits excludedStatusCategories from the payload when untouched", async () => {
      const user = userEvent.setup();
      const save = vi.fn().mockResolvedValue({});
      installMocks({ test: verifyOk(), save });
      renderDialog({
        plugin: jiraPlugin(),
        effective: { plugin: "jira-self-hosted", instance: "https://jira.acme.com" },
      });

      await user.click(screen.getByTestId("save-config"));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

      expect(save.mock.calls[0][0].excludedStatusCategories).toBeUndefined();
    });
  });

  it("bails out of Save when the implicit Verify fails, and renders the auth-error strip", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        kind: "auth",
        message: "Authentication failed: 401 Unauthorized. Check token scopes.",
      },
    });
    const save = vi.fn().mockResolvedValue({});
    installMocks({ test, save });
    renderDialog();

    await user.click(screen.getByTestId("save-config"));
    await waitFor(() => expect(screen.getByTestId("test-result-error-auth")).toBeInTheDocument());
    expect(save).not.toHaveBeenCalled();
  });

  it("renders the network-error strip on Verify failure", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        kind: "network",
        message: "Could not reach https://jira.invalid: ENOTFOUND. Check the URL and your VPN.",
      },
    });
    installMocks({ test, save: vi.fn() });
    renderDialog();

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() =>
      expect(screen.getByTestId("test-result-error-network")).toBeInTheDocument(),
    );
    expect(screen.getByText(/ENOTFOUND/)).toBeInTheDocument();
  });

  it("offers an inline 'Enable self-signed TLS' button on TLS error that flips the toggle and re-runs", async () => {
    const user = userEvent.setup();
    const test = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "tls", message: "TLS error: self-signed certificate." },
      })
      .mockResolvedValueOnce({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
      });
    installMocks({ test, save: vi.fn() });
    renderDialog();

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("test-result-error-tls")).toBeInTheDocument());

    await user.click(screen.getByTestId("enable-self-signed-tls"));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(2));

    expect(test.mock.calls[1][0]).toMatchObject({ allowSelfSignedTls: true });
    await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());
  });

  it("clears any stale Verify result when a config field changes", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-1", displayName: "Jane Doe" },
    });
    installMocks({ test, save: vi.fn() });
    renderDialog();

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());

    await user.type(inputIn("config-field-instance"), "x");

    expect(screen.queryByTestId("test-result-success")).not.toBeInTheDocument();
    // Save stays enabled because the gate is the connection pill, not a fresh
    // test. Save will re-run Verify and re-populate the strip.
    expect(screen.getByTestId("save-config")).not.toBeDisabled();
  });

  describe("per-category result strip (WU-041, FR-047)", () => {
    it("renders one row per category returned by the test (Issues always; alert categories when enabled)", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
        categories: [
          { category: "issues", label: "Issues", status: "ok" },
          {
            category: "code-scanning",
            label: "Code Scanning alerts",
            status: "ok",
            httpStatus: 200,
          },
          {
            category: "dependabot",
            label: "Dependabot alerts",
            status: "scope-missing",
            detail: "Token missing `security_events` scope.",
          },
        ],
      });
      installMocks({ test, save: vi.fn() });
      renderDialog();

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());

      expect(screen.getByText("Connected as Jane Doe.")).toBeInTheDocument();
      expect(screen.getByTestId("test-result-category-issues-ok")).toBeInTheDocument();
      expect(screen.getByTestId("test-result-category-code-scanning-ok")).toBeInTheDocument();
      expect(
        screen.getByTestId("test-result-category-dependabot-scope-missing"),
      ).toBeInTheDocument();
      expect(screen.getByText("Token missing `security_events` scope.")).toBeInTheDocument();
    });

    it("falls back to the single 'Connected as' row when the server returns no categories", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
      });
      installMocks({ test, save: vi.fn() });
      renderDialog();

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());

      expect(screen.getByText("Connected as Jane Doe.")).toBeInTheDocument();
      expect(screen.queryByTestId("test-result-category-issues-ok")).not.toBeInTheDocument();
    });
  });

  it("seeds initial values from the effective integration config (instance + advanced)", () => {
    installMocks({ test: vi.fn(), save: vi.fn() });
    renderDialog({
      effective: {
        plugin: "ghe",
        instance: "https://ghe.example",
        advanced: { allowSelfSignedTls: true },
      },
    });
    expect(inputIn("config-field-instance")).toHaveValue("https://ghe.example");
  });

  // FR-070 (WU-057): the github-com Configure modal hosts the Identity-resident
  // fields (Repository / Submodules). The GitHub Project picker is gone; the
  // server infers projects from the chosen repo.
  describe("integration fields section (WU-057)", () => {
    function githubPlugin(): Plugin {
      return {
        id: "github-com",
        installed: true,
        status: "enabled",
        manifest: {
          name: "GitHub",
          configSchema: { type: "object", properties: {} },
          permissions: {
            network: { hosts: [] },
            credentials: { slots: [] },
            filesystem: { paths: [] },
            processes: false,
          },
        },
      };
    }

    it("renders the Repository input for the github-com plugin without a separate Project picker", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockedUseFields.mockReturnValue({
        data: { repo: "acme/demo", layoutType: "single-repo" },
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      const section = screen.getByTestId("integration-fields-section");
      expect(section).toBeInTheDocument();
      expect(section.querySelector("input[placeholder='org/repo-name']")).toBeInTheDocument();
      // The standalone GitHub Project picker is no longer rendered: sources
      // and linked projects are derived from the repo on the server.
      expect(section.textContent).not.toMatch(/GitHub project/i);
      expect(section.textContent).not.toMatch(/Submodules/);
    });

    it("renders the Submodules editor only when the layout is meta-repo", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockedUseFields.mockReturnValue({
        data: { layoutType: "meta-repo", submodules: { backend: "apps/backend" } },
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      const section = screen.getByTestId("integration-fields-section");
      expect(section.textContent).toMatch(/Submodules/);
      expect(screen.getByDisplayValue("backend")).toBeInTheDocument();
      expect(screen.getByDisplayValue("apps/backend")).toBeInTheDocument();
    });

    it("persists changed fields through useSaveIntegrationFields on Save", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane" },
      });
      const save = vi.fn().mockResolvedValue({});
      const saveFields = vi.fn().mockResolvedValue({});
      installMocks({ test, save });
      mockedUseFields.mockReturnValue({
        data: { repo: "acme/old", layoutType: "single-repo" },
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      mockedUseSaveFields.mockReturnValue({
        mutateAsync: saveFields,
        isPending: false,
      } as unknown as ReturnType<typeof useSaveIntegrationFields>);

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      const repoInput = screen.getByPlaceholderText("org/repo-name");
      await user.clear(repoInput);
      await user.type(repoInput, "acme/new");

      await user.click(screen.getByTestId("save-config"));
      await waitFor(() => expect(saveFields).toHaveBeenCalledTimes(1));
      expect(saveFields.mock.calls[0][0]).toEqual({ repo: "acme/new" });
    });

    it("renders the derived-sources preview line when the server returns a derived repo set", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockedUseFields.mockReturnValue({
        data: { repo: "acme/demo", layoutType: "single-repo" },
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      mockedUseDerivedSources.mockReturnValue({
        data: {
          repos: ["acme/demo"],
          projects: [{ externalId: "acme/#1", label: "Planning" }],
          alertsRequested: ["code-scanning", "secret-scanning", "dependabot"],
        },
        isLoading: false,
      } as unknown as ReturnType<typeof useDerivedGithubSources>);

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      const preview = screen.getByTestId("derived-sources-preview");
      expect(preview).toHaveTextContent("acme/demo");
      expect(preview).toHaveTextContent("1 GitHub Project");
      expect(preview).toHaveTextContent(/security alerts/i);
    });

    it("warns when the derived-sources response has no matching repos", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockedUseFields.mockReturnValue({
        data: { repo: "acme/missing", layoutType: "single-repo" },
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      mockedUseDerivedSources.mockReturnValue({
        data: { repos: [], projects: [], alertsRequested: [] },
        isLoading: false,
      } as unknown as ReturnType<typeof useDerivedGithubSources>);

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      const preview = screen.getByTestId("derived-sources-preview");
      expect(preview).toHaveTextContent(/did not find this repository/i);
    });

    it("renders an actionable card when the repo's org has not approved the app", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockedUseFields.mockReturnValue({
        data: { repo: "int3nt/ai-agent-marketplace", layoutType: "single-repo" },
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      const orgApprovalError = new ApiError(
        "OAuth App access restrictions",
        403,
        "ORG_APPROVAL_REQUIRED",
        {
          error: "OAuth App access restrictions",
          code: "ORG_APPROVAL_REQUIRED",
          params: { owner: "int3nt" },
        },
      );
      mockedUseDerivedSources.mockReturnValue({
        data: undefined,
        isLoading: false,
        error: orgApprovalError,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof useDerivedGithubSources>);

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      expect(screen.getByText(/org approval required/i)).toBeInTheDocument();
      expect(screen.getByText(/int3nt/)).toBeInTheDocument();
      const link = screen.getByRole("link", { name: /request approval/i });
      expect(link).toHaveAttribute("href", expect.stringContaining("int3nt"));
    });

    it("renders the Repository input for the ghe plugin (GitHub family derives sources from the repo)", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockedUseFields.mockReturnValue({
        data: { repo: "acme/demo", layoutType: "single-repo" },
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      // renderDialog defaults to the ghe plugin.
      renderDialog();

      const section = screen.getByTestId("integration-fields-section");
      expect(section).toBeInTheDocument();
      expect(section.querySelector("input[placeholder='org/repo-name']")).toBeInTheDocument();
    });

    it("is hidden for non-GitHub-family plugins", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockedUseFields.mockReturnValue({
        data: undefined,
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      const jira: Plugin = {
        id: "jira-self-hosted",
        installed: true,
        status: "enabled",
        manifest: {
          name: "Self-hosted Jira",
          configSchema: { type: "object", properties: {} },
          permissions: {
            network: { hosts: [] },
            credentials: { slots: [] },
            filesystem: { paths: [] },
            processes: false,
          },
        },
      };
      renderDialog({
        plugin: jira,
        effective: { plugin: "jira-self-hosted" } as IntegrationConfig,
      });
      expect(screen.queryByTestId("integration-fields-section")).not.toBeInTheDocument();
    });
  });
});

describe("PluginConfigureDialog (global scope)", () => {
  const mockedUseGlobalTest = vi.mocked(useTestGlobalPluginIntegration);
  const mockedUseGlobalSave = vi.mocked(useSaveGlobalPluginIntegration);

  function installGlobalMocks(opts: {
    test: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    testPending?: boolean;
    savePending?: boolean;
  }) {
    mockedUseGlobalTest.mockReturnValue({
      mutateAsync: opts.test,
      isPending: opts.testPending ?? false,
    } as unknown as ReturnType<typeof useTestGlobalPluginIntegration>);
    mockedUseGlobalSave.mockReturnValue({
      mutateAsync: opts.save,
      isPending: opts.savePending ?? false,
    } as unknown as ReturnType<typeof useSaveGlobalPluginIntegration>);
    // Project-mode hooks must still be mocked since they're imported
    // unconditionally by the dialog; they should never be called.
    mockedUseTest.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useTestIntegrationConnection>);
    mockedUseSave.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useSaveIntegrationConfig>);
    mockedUseFields.mockReturnValue({
      data: undefined,
      isLoading: false,
    } as unknown as ReturnType<typeof useIntegrationFields>);
    mockedUseSaveFields.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useSaveIntegrationFields>);
    mockedUseDerivedSources.mockReturnValue({
      data: { repos: [], projects: [], alertsRequested: [] },
      isLoading: false,
    } as unknown as ReturnType<typeof useDerivedGithubSources>);
  }

  function renderGlobalDialog({
    plugin = makePlugin(),
    effective = { plugin: "ghe" } as IntegrationConfig,
    onClose = vi.fn(),
  }: {
    plugin?: Plugin;
    effective?: IntegrationConfig;
    onClose?: () => void;
  } = {}) {
    return renderWithProviders(
      <DialogTrigger
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <Button>Configure</Button>
        <PluginConfigureDialog scope="global" plugin={plugin} effective={effective} />
      </DialogTrigger>,
    );
  }

  it("invokes the global save mutation (not the project one) when Save runs the implicit Verify", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-7", displayName: "Globally Yours" },
    });
    const save = vi.fn().mockResolvedValue({});
    installGlobalMocks({ test, save });

    renderGlobalDialog({ effective: { plugin: "ghe", instance: "https://example" } });

    await user.click(screen.getByTestId("save-config"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].capturedUserId).toEqual({
      externalId: "u-7",
      displayName: "Globally Yours",
    });
    expect(mockedUseSave("demo").mutateAsync).not.toHaveBeenCalled();
  });

  it("omits the manifest's `sources` array property from the Verify snapshot", async () => {
    // Regression: GHE declares `sources` (type: array) in its configSchema.
    // seedInitialValues used to seed it as "" and that bogus non-array value
    // rode into the validateConfig test snapshot, so Verify/Save failed with
    // "sources: sources must be an array". The form must never carry `sources`.
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-9", displayName: "GHE User" },
    });
    const save = vi.fn().mockResolvedValue({});
    installGlobalMocks({ test, save });

    const plugin = makePlugin({
      configSchema: {
        type: "object",
        properties: {
          instance: { type: "string", title: "Instance URL" },
          token: { type: "string", format: "password", title: "Personal access token" },
          allowSelfSignedTls: { type: "boolean", title: "Allow self-signed TLS" },
          sources: { type: "array" },
        },
      },
    });
    renderGlobalDialog({ plugin, effective: { plugin: "ghe", instance: "https://ghe.example" } });

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(1));
    const snapshot = test.mock.calls[0][0] as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty("sources");
    expect(snapshot).toMatchObject({ instance: "https://ghe.example" });
  });

  it("omits `sources` from the Verify snapshot even when it leaks into effective.advanced", async () => {
    // Issue #125 defence-in-depth: a stale `advanced.sources` that survives
    // into `effective` (e.g. an un-canonicalised global override file) must
    // not ride into the form values via the `key in advanced` passthrough.
    // seedInitialValues skips array/object configSchema properties BEFORE
    // consulting `advanced`, so the snapshot stays clean.
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-9", displayName: "GHE User" },
    });
    const save = vi.fn().mockResolvedValue({});
    installGlobalMocks({ test, save });

    const plugin = makePlugin({
      configSchema: {
        type: "object",
        properties: {
          instance: { type: "string", title: "Instance URL" },
          sources: { type: "array" },
        },
      },
    });
    renderGlobalDialog({
      plugin,
      effective: {
        plugin: "ghe",
        instance: "https://ghe.example",
        advanced: { sources: "" } as IntegrationConfig["advanced"],
      },
    });

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(test).toHaveBeenCalledTimes(1));
    const snapshot = test.mock.calls[0][0] as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty("sources");
    expect(snapshot).toMatchObject({ instance: "https://ghe.example" });
  });

  it("appends '(global defaults)' to the dialog title", () => {
    installGlobalMocks({ test: vi.fn(), save: vi.fn() });
    renderGlobalDialog();
    expect(screen.getByText(/global defaults/i)).toBeInTheDocument();
  });

  it("does not render the Repository & Metadata section in global scope", () => {
    installGlobalMocks({ test: vi.fn(), save: vi.fn() });
    renderGlobalDialog();
    expect(screen.queryByTestId("integration-fields-section")).not.toBeInTheDocument();
  });

  describe("GitHub OAuth section", () => {
    function githubPlugin(): Plugin {
      return {
        id: "github-com",
        installed: true,
        status: "enabled",
        manifest: {
          name: "GitHub.com",
          configSchema: { type: "object", properties: {} },
          permissions: {
            network: { hosts: [] },
            credentials: {
              slots: [{ slot: "github-token", scope: "read", description: "OAuth token" }],
            },
            filesystem: { paths: [] },
            processes: false,
          },
        },
      };
    }

    it("renders the GitHub OAuth section only for the github-com plugin", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });

      const { unmount } = renderDialog();
      expect(screen.queryByTestId("github-oauth-section")).toBeNull();
      unmount();

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });
      expect(screen.getByTestId("github-oauth-section")).toBeInTheDocument();
    });

    it("renders the live GitHub login from the connection status as the account label", () => {
      installMocks({ test: vi.fn(), save: vi.fn(), account: { login: "octocat" } });
      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      const section = screen.getByTestId("github-oauth-section");
      expect(within(section).getByText("octocat")).toBeInTheDocument();
    });

    it("falls back to the persisted capturedUserId.externalId when the live status has no account", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      renderDialog({
        plugin: githubPlugin(),
        effective: {
          plugin: "github-com",
          capturedUserId: { externalId: "octocat", displayName: "The Octocat" },
        },
      });

      const section = screen.getByTestId("github-oauth-section");
      expect(within(section).getByText("octocat")).toBeInTheDocument();
    });

    it("falls back to the literal 'GitHub' when neither the live status nor the persisted identity carries a login", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      const section = screen.getByTestId("github-oauth-section");
      expect(within(section).getByText("GitHub")).toBeInTheDocument();
    });

    it("hides the prominent Connect button when the pill reads 'connected' and shows a low-emphasis Disconnect instead", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });
      expect(screen.queryByTestId("github-connect")).not.toBeInTheDocument();
      expect(screen.getByTestId("github-disconnect")).toBeInTheDocument();
    });

    it("shows the prominent Connect button when the pill reads anything other than 'connected'", () => {
      installMocks({ test: vi.fn(), save: vi.fn(), connectionState: "auth-problem" });
      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });
      expect(screen.getByTestId("github-connect")).toBeInTheDocument();
      expect(screen.queryByTestId("github-disconnect")).not.toBeInTheDocument();
    });

    it("opens the OAuth URL in a new window when Connect is clicked", async () => {
      installMocks({ test: vi.fn(), save: vi.fn(), connectionState: "auth-problem" });
      const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
      mockStartGithubPluginOauth.mockResolvedValue({ url: "https://github.com/login/oauth/auth" });

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });
      await userEvent.click(screen.getByTestId("github-connect"));

      await waitFor(() => expect(mockStartGithubPluginOauth).toHaveBeenCalled());
      expect(openSpy).toHaveBeenCalledWith(
        "https://github.com/login/oauth/auth",
        "_blank",
        "noopener,noreferrer",
      );
      openSpy.mockRestore();
    });

    it("calls the disconnect endpoint when the Disconnect link is clicked", async () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockDisconnectGithubPluginOauth.mockResolvedValue({ ok: true });

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });
      await userEvent.click(screen.getByTestId("github-disconnect"));

      await waitFor(() => expect(mockDisconnectGithubPluginOauth).toHaveBeenCalled());
    });

    it("surfaces an error message if the authorize call fails", async () => {
      installMocks({ test: vi.fn(), save: vi.fn(), connectionState: "auth-problem" });
      mockStartGithubPluginOauth.mockRejectedValue(new Error("server down"));

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });
      await userEvent.click(screen.getByTestId("github-connect"));
      await waitFor(() => expect(screen.getByText("server down")).toBeInTheDocument());
    });
  });

  describe("WU-050: opportunistic connection-status re-check on modal mount", () => {
    it("fires for the plugin when status is enabled", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      renderDialog({ plugin: makePlugin() });
      expect(useOpportunisticRecheckOnMountMock).toHaveBeenCalledWith(["ghe"]);
    });

    it("passes an empty list when the plugin is not enabled", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      const disabled: Plugin = { ...makePlugin(), status: "disabled" };
      renderDialog({ plugin: disabled });
      expect(useOpportunisticRecheckOnMountMock).toHaveBeenCalledWith([]);
    });
  });
});
