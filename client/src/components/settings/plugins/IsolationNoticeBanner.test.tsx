// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { IsolationNotice, PluginSource } from "@roubo/shared";

vi.mock("../../../hooks/usePlugins");
import { useReinstallShared as _useReinstallShared } from "../../../hooks/usePlugins";
import IsolationNoticeBanner from "./IsolationNoticeBanner";

const mockedUseReinstallShared = vi.mocked(_useReinstallShared);

function setupReinstall(
  overrides: { mutate?: ReturnType<typeof vi.fn>; isPending?: boolean; isSuccess?: boolean } = {},
) {
  const mutate = overrides.mutate ?? vi.fn();
  mockedUseReinstallShared.mockReturnValue({
    mutate,
    isPending: overrides.isPending ?? false,
    isSuccess: overrides.isSuccess ?? false,
  } as unknown as ReturnType<typeof _useReinstallShared>);
  return mutate;
}

const notice = (pluginDir: string): IsolationNotice => ({
  kind: "docker-mount-unshared",
  pluginDir,
  message: `The docker isolation tier could not engage because "${pluginDir}" is not a Docker Desktop shared path. Add this path to Docker Desktop > Settings > Resources > File sharing.`,
  at: "2026-06-25T00:00:00.000Z",
});

function renderBanner(
  notices: IsolationNotice[],
  source: PluginSource = "bundled",
  pluginId = "github-com",
) {
  return render(<IsolationNoticeBanner notices={notices} pluginId={pluginId} source={source} />);
}

describe("IsolationNoticeBanner (#743)", () => {
  beforeEach(() => {
    setupReinstall();
  });

  it("renders the notice message with the remediation as an amber advisory", () => {
    const { getByTestId } = renderBanner([notice("/Applications/Roubo.app/Contents/plugin")]);
    const banner = getByTestId("plugin-isolation-notice");
    expect(banner.textContent).toContain("/Applications/Roubo.app/Contents/plugin");
    expect(banner.textContent).toContain("Docker Desktop > Settings > Resources > File sharing");
    // Amber (advisory), not red: the plugin keeps running on the floor.
    expect(banner.className).toContain("amber");
    expect(banner.className).not.toContain("red");
  });

  it("lets a long plugin path wrap inside the card instead of overflowing (#754)", () => {
    const longPath = "/Applications/Roubo.app/Contents/Resources/plugins/github-com";
    const { getByTestId } = renderBanner([notice(longPath)]);
    const message = getByTestId("plugin-isolation-notice").querySelector("p");
    expect(message).not.toBeNull();
    // min-w-0 lets the flex text column shrink below the long token's intrinsic
    // width; break-words lets the unbreakable path wrap so it stays in the card.
    expect(message?.className).toContain("min-w-0");
    expect(message?.className).toContain("break-words");
    expect(message?.textContent).toContain(longPath);
  });

  it("renders one banner per notice", () => {
    const { getAllByTestId } = renderBanner([notice("/Applications/a"), notice("/Applications/b")]);
    expect(getAllByTestId("plugin-isolation-notice")).toHaveLength(2);
  });

  it("renders nothing when there are no notices", () => {
    const { queryByTestId } = renderBanner([]);
    expect(queryByTestId("plugin-isolation-notices")).toBeNull();
  });
});

describe("IsolationNoticeBanner reinstall action (#756)", () => {
  beforeEach(() => {
    setupReinstall();
  });

  it("offers the reinstall action for a bundled plugin with a docker-mount-unshared notice", () => {
    const { getByTestId } = renderBanner([notice("/Applications/a")], "bundled");
    expect(getByTestId("plugin-reinstall-shared").textContent).toContain(
      "Reinstall in shared location",
    );
  });

  it("does not offer the action for a user plugin", () => {
    const { queryByTestId } = renderBanner([notice("/Applications/a")], "user");
    expect(queryByTestId("plugin-reinstall-shared")).toBeNull();
  });

  it("triggers the reinstall mutation with the plugin id when pressed", async () => {
    const user = userEvent.setup();
    const mutate = setupReinstall();
    const { getByTestId } = renderBanner([notice("/Applications/a")], "bundled", "github-com");
    await user.click(getByTestId("plugin-reinstall-shared"));
    expect(mutate).toHaveBeenCalledWith("github-com");
  });

  it("disables the button and shows progress while pending", () => {
    setupReinstall({ isPending: true });
    const { getByTestId } = renderBanner([notice("/Applications/a")], "bundled");
    const btn = getByTestId("plugin-reinstall-shared");
    expect(btn.textContent).toContain("Reinstalling");
    expect(btn).toBeDisabled();
  });

  it("shows a success state once the reinstall succeeds", () => {
    setupReinstall({ isSuccess: true });
    const { getByTestId, queryByTestId } = renderBanner([notice("/Applications/a")], "bundled");
    expect(getByTestId("plugin-reinstall-shared-done").textContent).toContain(
      "Reinstalled in shared location",
    );
    expect(queryByTestId("plugin-reinstall-shared")).toBeNull();
  });
});
