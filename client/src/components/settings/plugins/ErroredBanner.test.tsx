// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

describe("ErroredBanner (TC-016)", () => {
  beforeEach(() => setup());

  it("renders the 3-restart-attempts copy and a last-good-snapshot mention", () => {
    render(<ErroredBanner pluginId="github-com" onViewLogs={() => {}} />);
    const banner = screen.getByTestId("plugin-errored-banner");
    expect(banner.textContent).toContain("Plugin failed to start after 3 restart attempts");
    expect(banner.textContent).toContain("last successful issue snapshot");
  });

  it("calls restart mutation when Restart is pressed", async () => {
    const user = userEvent.setup();
    const mutate = setup();
    render(<ErroredBanner pluginId="github-com" onViewLogs={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Restart" }));
    expect(mutate).toHaveBeenCalledWith("github-com");
  });

  it("calls onViewLogs when View logs is pressed", async () => {
    const user = userEvent.setup();
    const onViewLogs = vi.fn();
    render(<ErroredBanner pluginId="github-com" onViewLogs={onViewLogs} />);
    await user.click(screen.getByRole("button", { name: "View logs" }));
    expect(onViewLogs).toHaveBeenCalled();
  });

  it("disables Restart and shows pending label while pending", () => {
    setup(vi.fn(), true);
    render(<ErroredBanner pluginId="github-com" onViewLogs={() => {}} />);
    const btn = screen.getByRole("button", { name: "Restarting..." });
    expect(btn).toBeDisabled();
  });
});
