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

const mockedUseTest = vi.mocked(useTestIntegrationConnection);
const mockedUseSave = vi.mocked(useSaveIntegrationConfig);
const mockedUseSourceCandidates = vi.mocked(useSourceCandidates);
const mockedUseSaveSources = vi.mocked(useSaveProjectSources);

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
      <PluginConfigureDialog projectId="demo" plugin={plugin} effective={effective} />
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
});
