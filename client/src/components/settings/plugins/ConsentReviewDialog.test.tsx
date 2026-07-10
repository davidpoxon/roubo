// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginPermissions } from "@roubo/shared";

vi.mock("../../../hooks/usePlugins");
import { useGrantConsent as _useGrantConsent } from "../../../hooks/usePlugins";
import ConsentReviewDialog from "./ConsentReviewDialog";

const mockedGrantConsent = vi.mocked(_useGrantConsent);

function permissions(over: Partial<PluginPermissions> = {}): PluginPermissions {
  return {
    network: { hosts: [] },
    credentials: { slots: [] },
    filesystem: { paths: [] },
    processes: false,
    ...over,
  };
}

// The database plugin declares docker; the process plugin declares nothing.
const dockerPerms = permissions({ docker: {} });
const noPerms = permissions();

function grantState(over: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    ...over,
  } as unknown as ReturnType<typeof _useGrantConsent>;
}

beforeEach(() => {
  mockedGrantConsent.mockReturnValue(grantState());
});

describe("ConsentReviewDialog: declared permissions (issue #490)", () => {
  it("renders the trust banner and each declared permission category", () => {
    render(
      <ConsentReviewDialog
        pluginId="database"
        pluginName="Database"
        declared={dockerPerms}
        version="1.0.0"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("consent-review-trust")).toBeTruthy();
    const list = screen.getByTestId("consent-review-list");
    expect(within(list).getByText("Docker")).toBeTruthy();
    expect(list.querySelector('[data-category="docker"]')).toBeTruthy();
    expect(screen.queryByTestId("consent-review-no-permissions")).toBeNull();
  });

  it("shows the no-declared-permissions message when the plugin declares nothing", () => {
    render(
      <ConsentReviewDialog
        pluginId="process"
        pluginName="Process"
        declared={noPerms}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("consent-review-no-permissions")).toBeTruthy();
    expect(screen.queryByTestId("consent-review-list")).toBeNull();
  });
});

describe("ConsentReviewDialog: acknowledge gate (issue #490)", () => {
  it("does not grant consent while the acknowledge checkbox is unchecked", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockedGrantConsent.mockReturnValue(grantState({ mutate }));
    render(
      <ConsentReviewDialog
        pluginId="database"
        pluginName="Database"
        declared={dockerPerms}
        onClose={vi.fn()}
      />,
    );
    const confirm = screen.getByTestId("consent-review-confirm");
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    await user.click(confirm);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("grants consent with the declared categories once acknowledged", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockedGrantConsent.mockReturnValue(grantState({ mutate }));
    render(
      <ConsentReviewDialog
        pluginId="database"
        pluginName="Database"
        declared={dockerPerms}
        onClose={vi.fn()}
      />,
    );
    await user.click(within(screen.getByTestId("consent-review-ack")).getByRole("checkbox"));
    const confirm = screen.getByTestId("consent-review-confirm");
    expect(confirm.getAttribute("aria-disabled")).toBe("false");
    await user.click(confirm);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      pluginId: "database",
      acknowledgedCategories: ["docker"],
    });
  });

  it("grants consent with an empty category set for a plugin that declares nothing", async () => {
    const user = userEvent.setup();
    const mutate = vi.fn();
    mockedGrantConsent.mockReturnValue(grantState({ mutate }));
    render(
      <ConsentReviewDialog
        pluginId="process"
        pluginName="Process"
        declared={noPerms}
        onClose={vi.fn()}
      />,
    );
    await user.click(within(screen.getByTestId("consent-review-ack")).getByRole("checkbox"));
    await user.click(screen.getByTestId("consent-review-confirm"));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toEqual({
      pluginId: "process",
      acknowledgedCategories: [],
    });
  });
});

describe("ConsentReviewDialog: outcome (issue #490)", () => {
  it("closes on a successful grant", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const mutate = vi.fn((_vars, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
    mockedGrantConsent.mockReturnValue(grantState({ mutate }));
    render(
      <ConsentReviewDialog
        pluginId="database"
        pluginName="Database"
        declared={dockerPerms}
        onClose={onClose}
      />,
    );
    await user.click(within(screen.getByTestId("consent-review-ack")).getByRole("checkbox"));
    await user.click(screen.getByTestId("consent-review-confirm"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes without granting when Cancel is pressed", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const mutate = vi.fn();
    mockedGrantConsent.mockReturnValue(grantState({ mutate }));
    render(
      <ConsentReviewDialog
        pluginId="database"
        pluginName="Database"
        declared={dockerPerms}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId("consent-review-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("surfaces an inline error when the grant fails", () => {
    mockedGrantConsent.mockReturnValue(
      grantState({ isError: true, error: new Error("consent store write failed") }),
    );
    render(
      <ConsentReviewDialog
        pluginId="database"
        pluginName="Database"
        declared={dockerPerms}
        onClose={vi.fn()}
      />,
    );
    const alert = screen.getByTestId("consent-review-error");
    expect(alert.textContent).toContain("consent store write failed");
  });
});
