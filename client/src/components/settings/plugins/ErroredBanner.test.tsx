// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginError } from "@roubo/shared";

vi.mock("../../../hooks/usePlugins");
import { useRestartPlugin as _useRestartPlugin } from "../../../hooks/usePlugins";
import ErroredBanner from "./ErroredBanner";

const mockedUseRestart = vi.mocked(_useRestartPlugin);

function setup(mutate = vi.fn(), pending = false) {
  mockedUseRestart.mockReturnValue({
    mutate,
    isPending: pending,
  } as unknown as ReturnType<typeof _useRestartPlugin>);
  return mutate;
}

const missingEntryError: PluginError = {
  code: "missing-entry",
  message:
    "Plugin entry file not found: ./dist/index.js. The plugin may not be built; reinstall it from the marketplace.",
};

describe("ErroredBanner (issue #302)", () => {
  beforeEach(() => setup());

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
    const mutate = setup();
    render(
      <ErroredBanner
        pluginId="github-com"
        lastError={missingEntryError}
        kind="component"
        onViewLogs={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Restart" }));
    expect(mutate).toHaveBeenCalledWith("github-com");
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
    setup(vi.fn(), true);
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
