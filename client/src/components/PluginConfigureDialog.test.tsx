// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button, DialogTrigger } from "react-aria-components";
import type {
  IntegrationConfig,
  ProjectIntegrationState,
  SourceCandidatesResponse,
} from "@roubo/shared";
import { renderWithProviders } from "../test/renderWithProviders";
import PluginConfigureDialog from "./PluginConfigureDialog";
import {
  useTestIntegrationConnection,
  useSaveIntegrationConfig,
} from "../hooks/useProjectIntegration";
import { useSourceCandidates } from "../hooks/useSourceCandidates";
import { useSaveProjectSources } from "../hooks/useSaveProjectSources";
import { useIntegrationFields, useSaveIntegrationFields } from "../hooks/useIntegrationFields";
import { useGitHubProjects } from "../hooks/useSetup";
import {
  useTestGlobalPluginIntegration,
  useSaveGlobalPluginIntegration,
} from "../hooks/useGlobalPluginIntegration";

vi.mock("../hooks/useProjectIntegration", () => ({
  useTestIntegrationConnection: vi.fn(),
  useSaveIntegrationConfig: vi.fn(),
}));

vi.mock("../hooks/useSourceCandidates", () => ({
  useSourceCandidates: vi.fn(),
}));

vi.mock("../hooks/useSaveProjectSources", () => ({
  useSaveProjectSources: vi.fn(),
}));

vi.mock("../hooks/useIntegrationFields", () => ({
  useIntegrationFields: vi.fn(),
  useSaveIntegrationFields: vi.fn(),
}));

vi.mock("../hooks/useSetup", () => ({
  useGitHubProjects: vi.fn(),
}));

vi.mock("../hooks/useGlobalPluginIntegration", () => ({
  useTestGlobalPluginIntegration: vi.fn(),
  useSaveGlobalPluginIntegration: vi.fn(),
  useGlobalPluginIntegration: vi.fn(),
}));

const { useOpportunisticRecheckOnMountMock } = vi.hoisted(() => ({
  useOpportunisticRecheckOnMountMock: vi.fn(),
}));
vi.mock("../hooks/usePlugins", async () => {
  const actual = await vi.importActual<typeof import("../hooks/usePlugins")>("../hooks/usePlugins");
  return {
    ...actual,
    useOpportunisticRecheckOnMount: useOpportunisticRecheckOnMountMock,
  };
});

const { useIssueListWarningsMock } = vi.hoisted(() => ({
  useIssueListWarningsMock: vi.fn() as unknown as ReturnType<
    typeof vi.fn<(projectId: string | undefined) => import("@roubo/shared").ListIssuesWarning[]>
  >,
}));
useIssueListWarningsMock.mockReturnValue([]);
vi.mock("../hooks/useIssues", () => ({ useIssueListWarnings: useIssueListWarningsMock }));

const { mockStartGithubPluginOauth } = vi.hoisted(() => ({
  mockStartGithubPluginOauth: vi.fn(),
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, startGithubPluginOauth: mockStartGithubPluginOauth };
});

const mockedUseTest = vi.mocked(useTestIntegrationConnection);
const mockedUseSave = vi.mocked(useSaveIntegrationConfig);
const mockedUseSourceCandidates = vi.mocked(useSourceCandidates);
const mockedUseSaveSources = vi.mocked(useSaveProjectSources);
const mockedUseFields = vi.mocked(useIntegrationFields);
const mockedUseSaveFields = vi.mocked(useSaveIntegrationFields);
const mockedUseGitHubProjects = vi.mocked(useGitHubProjects);

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
  saveSources?: ReturnType<typeof vi.fn>;
  candidates?: {
    data?: SourceCandidatesResponse;
    isLoading?: boolean;
    isError?: boolean;
    error?: unknown;
  };
  testPending?: boolean;
  savePending?: boolean;
  saveSourcesPending?: boolean;
}) {
  mockedUseTest.mockReturnValue({
    mutateAsync: opts.test,
    isPending: opts.testPending ?? false,
  } as unknown as ReturnType<typeof useTestIntegrationConnection>);
  mockedUseSave.mockReturnValue({
    mutateAsync: opts.save,
    isPending: opts.savePending ?? false,
  } as unknown as ReturnType<typeof useSaveIntegrationConfig>);
  mockedUseSaveSources.mockReturnValue({
    mutateAsync: opts.saveSources ?? vi.fn().mockResolvedValue({}),
    isPending: opts.saveSourcesPending ?? false,
  } as unknown as ReturnType<typeof useSaveProjectSources>);
  mockedUseSourceCandidates.mockReturnValue({
    data: opts.candidates?.data,
    isLoading: opts.candidates?.isLoading ?? false,
    isError: opts.candidates?.isError ?? false,
    error: opts.candidates?.error ?? null,
  } as unknown as ReturnType<typeof useSourceCandidates>);
  mockedUseFields.mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useIntegrationFields>);
  mockedUseSaveFields.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  } as unknown as ReturnType<typeof useSaveIntegrationFields>);
  mockedUseGitHubProjects.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useGitHubProjects>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PluginConfigureDialog", () => {
  it("disables Save before any test has run, and enables it after a successful test (TC-037)", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-1", displayName: "Jane Doe" },
    });
    const save = vi.fn().mockResolvedValue({});
    installMocks({ test, save });

    renderDialog();

    const saveBtn = screen.getByTestId("save-config");
    expect(saveBtn).toBeDisabled();

    await user.click(screen.getByTestId("test-connection"));

    await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());
    expect(screen.getByText("Connected as Jane Doe.")).toBeInTheDocument();
    expect(saveBtn).not.toBeDisabled();
  });

  it("submits the captured externalId on save and closes the dialog (TC-038)", async () => {
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

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(test).toHaveBeenCalled());

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

  it("keeps Save disabled and shows the structured auth-error message (TC-060)", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        kind: "auth",
        message: "Authentication failed: 401 Unauthorized. Check token scopes.",
      },
    });
    installMocks({ test, save: vi.fn() });

    renderDialog();

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(screen.getByTestId("test-result-error-auth")).toBeInTheDocument());
    expect(
      screen.getByText("Authentication failed: 401 Unauthorized. Check token scopes."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("save-config")).toBeDisabled();
  });

  it("renders the network-error strip and keeps Save disabled (TC-061)", async () => {
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
    expect(screen.getByTestId("save-config")).toBeDisabled();
  });

  it("offers an inline 'Enable self-signed TLS' button on TLS error that flips the toggle and re-runs (TC-062)", async () => {
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

    // The retry must have been sent with the TLS toggle set to true.
    expect(test.mock.calls[1][0]).toMatchObject({ allowSelfSignedTls: true });
    await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());
    expect(screen.getByTestId("save-config")).not.toBeDisabled();
  });

  it("resets the tested-successfully state when any field changes (FR-034)", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-1", displayName: "Jane Doe" },
    });
    installMocks({ test, save: vi.fn() });

    renderDialog();

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(screen.getByTestId("save-config")).not.toBeDisabled());

    await user.type(inputIn("config-field-instance"), "x");

    expect(screen.getByTestId("save-config")).toBeDisabled();
    expect(screen.queryByTestId("test-result-success")).not.toBeInTheDocument();
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

    it("never renders a row for a disabled category (AC: 'not 'not-enabled' placeholders')", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
        categories: [{ category: "issues", label: "Issues", status: "ok" }],
      });
      installMocks({ test, save: vi.fn() });
      renderDialog();

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());

      expect(screen.getByTestId("test-result-category-issues-ok")).toBeInTheDocument();
      expect(
        screen.queryByTestId("test-result-category-code-scanning-not-enabled"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("test-result-category-secret-scanning-not-enabled"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("test-result-category-dependabot-not-enabled"),
      ).not.toBeInTheDocument();
    });

    it("renders a timed-out row with amber styling and keeps the strip in success tone (TC-103)", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
        categories: [
          { category: "issues", label: "Issues", status: "ok" },
          {
            category: "code-scanning",
            label: "Code Scanning alerts",
            status: "timed-out",
            detail: "Timed out",
          },
          {
            category: "secret-scanning",
            label: "Secret Scanning alerts",
            status: "ok",
            httpStatus: 200,
          },
          {
            category: "dependabot",
            label: "Dependabot alerts",
            status: "ok",
            httpStatus: 200,
          },
        ],
      });
      installMocks({ test, save: vi.fn() });
      renderDialog();

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());

      const timedOutRow = screen.getByTestId("test-result-category-code-scanning-timed-out");
      expect(timedOutRow).toBeInTheDocument();
      // The row's text and detail use amber tones.
      expect(timedOutRow.querySelector(".text-amber-800")).not.toBeNull();
      expect(screen.getByText("Timed out")).toBeInTheDocument();
      // Overall strip is in amber (not red) tone: timed-out is non-fatal, but
      // the worst-status helper bumps the container above plain green.
      expect(screen.getByTestId("test-result-success").className).toMatch(/amber/);
      expect(screen.getByText("Connected as Jane Doe.")).toBeInTheDocument();
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

  describe("sources section (#71)", () => {
    const candidates: SourceCandidatesResponse = {
      shape: "multi-list",
      items: [
        { externalId: "repo-1", label: "acme/api" },
        { externalId: "repo-2", label: "acme/web" },
      ],
    };

    it("hides the section before a successful test", () => {
      installMocks({
        test: vi.fn(),
        save: vi.fn(),
        candidates: { data: candidates },
      });
      renderDialog();
      expect(screen.queryByTestId("sources-section")).not.toBeInTheDocument();
    });

    it("auto-saves instance + advanced when the test passes, then renders the picker", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
      });
      const save = vi.fn().mockResolvedValue({});
      installMocks({
        test,
        save,
        candidates: { data: candidates },
      });
      renderDialog({ effective: { plugin: "ghe", instance: "https://ghe.example" } });

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

      const payload = save.mock.calls[0][0];
      expect(payload.capturedUserId).toEqual({ externalId: "u-1", displayName: "Jane Doe" });
      expect(payload.instance).toBe("https://ghe.example");
      expect(payload.token).toBeUndefined();

      await waitFor(() => expect(screen.getByTestId("sources-section")).toBeInTheDocument());
      expect(screen.getByText("acme/api")).toBeInTheDocument();
      expect(screen.getByText("acme/web")).toBeInTheDocument();
    });

    it("persists the selected sources via useSaveProjectSources on Save", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
      });
      const save = vi.fn().mockResolvedValue({});
      const saveSources = vi.fn().mockResolvedValue({});
      installMocks({
        test,
        save,
        saveSources,
        candidates: { data: candidates },
      });
      const onClose = vi.fn();
      renderDialog({
        effective: { plugin: "ghe", instance: "https://ghe.example" },
        onClose,
      });

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("sources-section")).toBeInTheDocument());

      await user.click(screen.getByText("acme/api"));
      await user.click(screen.getByText("acme/web"));

      await user.click(screen.getByTestId("save-config"));
      await waitFor(() => expect(saveSources).toHaveBeenCalledTimes(1));

      expect(saveSources.mock.calls[0][0]).toEqual({ items: ["repo-1", "repo-2"] });
      expect(onClose).toHaveBeenCalled();
    });

    it("hides the section entirely when the plugin returns no candidates", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
      });
      installMocks({
        test,
        save: vi.fn().mockResolvedValue({}),
        candidates: { data: { shape: "multi-list", items: [] } },
      });
      renderDialog();

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());

      expect(screen.queryByTestId("sources-section")).not.toBeInTheDocument();
    });

    it("hides the section when listSourceCandidates errors (e.g. plugin returns 502)", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
      });
      installMocks({
        test,
        save: vi.fn().mockResolvedValue({}),
        candidates: { isError: true, error: new Error("Plugin listSourceCandidates failed") },
      });
      renderDialog();

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());

      expect(screen.queryByTestId("sources-section")).not.toBeInTheDocument();
    });

    it("hides the section again when the user changes any field after a successful test", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
      });
      installMocks({
        test,
        save: vi.fn().mockResolvedValue({}),
        candidates: { data: candidates },
      });
      renderDialog();

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("sources-section")).toBeInTheDocument());

      await user.type(inputIn("config-field-instance"), "x");

      expect(screen.queryByTestId("sources-section")).not.toBeInTheDocument();
      expect(screen.queryByTestId("test-result-success")).not.toBeInTheDocument();
    });

    it("seeds the source-selection state from the effective override", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
      });
      const saveSources = vi.fn().mockResolvedValue({});
      installMocks({
        test,
        save: vi.fn().mockResolvedValue({}),
        saveSources,
        candidates: { data: candidates },
      });
      renderDialog({
        effective: {
          plugin: "ghe",
          instance: "https://ghe.example",
          sources: { items: ["repo-1"] },
        },
      });

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("sources-section")).toBeInTheDocument());

      // Saving without touching the picker should re-emit the seeded selection.
      await user.click(screen.getByTestId("save-config"));
      await waitFor(() => expect(saveSources).toHaveBeenCalledTimes(1));
      expect(saveSources.mock.calls[0][0]).toEqual({ items: ["repo-1"] });
    });
  });

  describe("OAuth re-consent inline action (WU-031)", () => {
    const candidates: SourceCandidatesResponse = {
      shape: "multi-list",
      items: [
        { externalId: "repo-1", label: "acme/api", icon: "repo" },
        { externalId: "repo-2", label: "acme/web", icon: "repo" },
      ],
    };

    it("renders the chip-as-button inside the Security Alerts disclosure when listIssues returns a 401, and opening the dialog leaves Configure mounted", async () => {
      useIssueListWarningsMock.mockReturnValue([
        {
          category: "code-scanning",
          sourceExternalId: "repo-1",
          cause: "Code Scanning unavailable: missing security_events scope on the GitHub token.",
          detail: { status: 401 },
        },
      ]);
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane Doe" },
      });
      installMocks({
        test,
        save: vi.fn().mockResolvedValue({}),
        candidates: { data: candidates },
      });

      renderDialog({
        plugin: makePlugin({ name: "GitHub" }),
        effective: {
          plugin: "ghe",
          instance: "https://github.com",
          sources: { items: [{ externalId: "repo-1", includeCodeQLAlerts: true }] },
        },
      });

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByTestId("sources-section")).toBeInTheDocument());

      await user.click(
        screen.getByRole("button", { name: /Security & quality alerts for acme\/api/i }),
      );

      // The chip is now a button (interactive re-consent affordance).
      const chip = await screen.findByRole("button", { name: /unavailable/i });
      expect(chip.tagName).toBe("BUTTON");

      await user.click(chip);

      // OAuth re-consent dialog opens AND the Configure dialog is still mounted.
      expect(screen.getByTestId("oauth-reconsent-dialog")).toBeInTheDocument();
      expect(screen.getByTestId("save-config")).toBeInTheDocument();
    });
  });

  // FR-070 (WU-057): the github-com Configure modal hosts the Identity-resident
  // fields (Repository / Linked GitHub Project / Submodules).
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

    it("renders Repository and GitHub project for the github-com plugin", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockedUseFields.mockReturnValue({
        data: { repo: "acme/demo", layoutType: "single-repo" },
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      const section = screen.getByTestId("integration-fields-section");
      expect(section).toBeInTheDocument();
      expect(section.querySelector("input[placeholder='org/repo-name']")).toBeInTheDocument();
      expect(section.textContent).toMatch(/GitHub project/i);
      // single-repo: Submodules editor is hidden (no Submodules label rendered).
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
      // Existing alias/dir surface as inputs in the editor.
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

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(test).toHaveBeenCalled());

      await user.click(screen.getByTestId("save-config"));
      await waitFor(() => expect(saveFields).toHaveBeenCalledTimes(1));
      expect(saveFields.mock.calls[0][0]).toEqual({ repo: "acme/new" });
    });

    it("skips the save mutation when no field changed", async () => {
      const user = userEvent.setup();
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "Jane" },
      });
      const saveFields = vi.fn().mockResolvedValue({});
      installMocks({ test, save: vi.fn().mockResolvedValue({}) });
      mockedUseFields.mockReturnValue({
        data: { repo: "acme/demo", layoutType: "single-repo" },
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      mockedUseSaveFields.mockReturnValue({
        mutateAsync: saveFields,
        isPending: false,
      } as unknown as ReturnType<typeof useSaveIntegrationFields>);

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });

      await user.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(test).toHaveBeenCalled());
      await user.click(screen.getByTestId("save-config"));
      await waitFor(() => expect(screen.queryByTestId("save-config")).not.toBeInTheDocument(), {
        timeout: 500,
      }).catch(() => {});
      expect(saveFields).not.toHaveBeenCalled();
    });

    it("is hidden for non-github plugins", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockedUseFields.mockReturnValue({
        data: undefined,
        isLoading: false,
      } as unknown as ReturnType<typeof useIntegrationFields>);
      renderDialog();
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
    mockedUseSaveSources.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useSaveProjectSources>);
    mockedUseSourceCandidates.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      error: null,
    } as unknown as ReturnType<typeof useSourceCandidates>);
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

  it("never renders the Sources picker, even after a successful test", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-1", displayName: "Jane Doe" },
    });
    const save = vi.fn().mockResolvedValue({});
    installGlobalMocks({ test, save });

    renderGlobalDialog({ effective: { plugin: "ghe", instance: "https://example" } });

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(screen.getByTestId("test-result-success")).toBeInTheDocument());

    expect(screen.queryByTestId("sources-section")).not.toBeInTheDocument();
    // Source candidates should never have been queried.
    expect(mockedUseSourceCandidates).toHaveBeenCalledWith("", null);
  });

  it("invokes the global save mutation (not the project one) on a successful test", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-7", displayName: "Globally Yours" },
    });
    const save = vi.fn().mockResolvedValue({});
    installGlobalMocks({ test, save });

    renderGlobalDialog({ effective: { plugin: "ghe", instance: "https://example" } });

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].capturedUserId).toEqual({
      externalId: "u-7",
      displayName: "Globally Yours",
    });
    // The project-mode save mutation must NOT be touched.
    expect(mockedUseSave("demo").mutateAsync).not.toHaveBeenCalled();
  });

  it("closes the dialog on Save without calling any sources mutation", async () => {
    const user = userEvent.setup();
    const test = vi.fn().mockResolvedValue({
      ok: true,
      identity: { externalId: "u-1", displayName: "Jane Doe" },
    });
    const save = vi.fn().mockResolvedValue({});
    const onClose = vi.fn();
    installGlobalMocks({ test, save });

    renderGlobalDialog({ effective: { plugin: "ghe", instance: "https://example" }, onClose });

    await user.click(screen.getByTestId("test-connection"));
    await waitFor(() => expect(screen.getByTestId("save-config")).not.toBeDisabled());

    await user.click(screen.getByTestId("save-config"));
    expect(onClose).toHaveBeenCalled();
    // saveSourcesMutation belongs to the project scope and must remain untouched.
    expect(mockedUseSaveSources("demo").mutateAsync).not.toHaveBeenCalled();
  });

  it("appends '(global defaults)' to the dialog title", () => {
    installGlobalMocks({ test: vi.fn(), save: vi.fn() });
    renderGlobalDialog();
    expect(screen.getByText(/global defaults/i)).toBeInTheDocument();
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

    it("opens the OAuth URL in a new window when Connect is clicked", async () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
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

    it("shows the connected username once the test succeeds", async () => {
      const test = vi.fn().mockResolvedValue({
        ok: true,
        identity: { externalId: "u-1", displayName: "octocat" },
      });
      const save = vi.fn().mockResolvedValue({});
      installMocks({ test, save });

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });
      await userEvent.click(screen.getByTestId("test-connection"));
      await waitFor(() => expect(screen.getByText("octocat")).toBeInTheDocument());
      expect(screen.getByRole("button", { name: /reconnect/i })).toBeInTheDocument();
    });

    it("surfaces an error message if the authorize call fails", async () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      mockStartGithubPluginOauth.mockRejectedValue(new Error("server down"));

      renderDialog({ plugin: githubPlugin(), effective: { plugin: "github-com" } });
      await userEvent.click(screen.getByTestId("github-connect"));
      await waitFor(() => expect(screen.getByText("server down")).toBeInTheDocument());
    });
  });

  describe("WU-050: opportunistic connection-status re-check on modal mount", () => {
    it("fires for the plugin when status is enabled", () => {
      installMocks({ test: vi.fn(), save: vi.fn() });
      renderDialog({ plugin: makePlugin() }); // makePlugin status = "enabled"
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
