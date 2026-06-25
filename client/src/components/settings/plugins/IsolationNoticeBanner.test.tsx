// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { IsolationNotice } from "@roubo/shared";
import IsolationNoticeBanner from "./IsolationNoticeBanner";

const notice = (pluginDir: string): IsolationNotice => ({
  kind: "docker-mount-unshared",
  pluginDir,
  message: `The docker isolation tier could not engage because "${pluginDir}" is not a Docker Desktop shared path. Add this path to Docker Desktop > Settings > Resources > File sharing.`,
  at: "2026-06-25T00:00:00.000Z",
});

describe("IsolationNoticeBanner (#743)", () => {
  it("renders the notice message with the remediation as an amber advisory", () => {
    const { getByTestId } = render(
      <IsolationNoticeBanner notices={[notice("/Applications/Roubo.app/Contents/plugin")]} />,
    );
    const banner = getByTestId("plugin-isolation-notice");
    expect(banner.textContent).toContain("/Applications/Roubo.app/Contents/plugin");
    expect(banner.textContent).toContain("Docker Desktop > Settings > Resources > File sharing");
    // Amber (advisory), not red: the plugin keeps running on the floor.
    expect(banner.className).toContain("amber");
    expect(banner.className).not.toContain("red");
  });

  it("renders one banner per notice", () => {
    const { getAllByTestId } = render(
      <IsolationNoticeBanner notices={[notice("/Applications/a"), notice("/Applications/b")]} />,
    );
    expect(getAllByTestId("plugin-isolation-notice")).toHaveLength(2);
  });

  it("renders nothing when there are no notices", () => {
    const { queryByTestId } = render(<IsolationNoticeBanner notices={[]} />);
    expect(queryByTestId("plugin-isolation-notices")).toBeNull();
  });
});
