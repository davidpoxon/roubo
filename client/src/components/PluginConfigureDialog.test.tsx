// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IntegrationConfig, ProjectIntegrationState } from "@roubo/shared";
import { renderWithProviders } from "../test/renderWithProviders";
import PluginConfigureDialog from "./PluginConfigureDialog";
import {
  useTestIntegrationConnection,
  useSaveIntegrationConfig,
} from "../hooks/useProjectIntegration";

vi.mock("../hooks/useProjectIntegration", () => ({
  useTestIntegrationConnection: vi.fn(),
  useSaveIntegrationConfig: vi.fn(),
}));

const mockedUseTest = vi.mocked(useTestIntegrationConnection);
const mockedUseSave = vi.mocked(useSaveIntegrationConfig);

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
    <PluginConfigureDialog
      projectId="demo"
      plugin={plugin}
      effective={effective}
      onClose={onClose}
    />,
  );
}

function installMocks(opts: {
  test: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  testPending?: boolean;
  savePending?: boolean;
}) {
  mockedUseTest.mockReturnValue({
    mutateAsync: opts.test,
    isPending: opts.testPending ?? false,
  } as unknown as ReturnType<typeof useTestIntegrationConnection>);
  mockedUseSave.mockReturnValue({
    mutateAsync: opts.save,
    isPending: opts.savePending ?? false,
  } as unknown as ReturnType<typeof useSaveIntegrationConfig>);
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
});
