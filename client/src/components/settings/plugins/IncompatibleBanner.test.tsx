// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import IncompatibleBanner from "./IncompatibleBanner";

describe("IncompatibleBanner (TC-003)", () => {
  it("includes the plugin's declared host range and the host's API version", () => {
    const { getByTestId } = render(
      <IncompatibleBanner pluginRange="^2.0.0" hostApiVersion="1.0.0" />,
    );
    const banner = getByTestId("plugin-incompatible-banner");
    expect(banner.textContent).toContain("^2.0.0");
    expect(banner.textContent).toContain("1.0.0");
    expect(banner.textContent).toContain("Update the plugin or use a newer Roubo");
  });

  it("uses amber tint", () => {
    const { getByTestId } = render(
      <IncompatibleBanner pluginRange="^2.0.0" hostApiVersion="1.0.0" />,
    );
    expect(getByTestId("plugin-incompatible-banner").className).toContain("amber");
  });
});
