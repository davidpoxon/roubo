// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import InvalidBanner from "./InvalidBanner";

describe("InvalidBanner (TC-002)", () => {
  it("renders the supervisor's error message", () => {
    const { getByTestId } = render(<InvalidBanner message="Manifest missing 'entry' field" />);
    const banner = getByTestId("plugin-invalid-banner");
    expect(banner.textContent).toContain("Manifest missing 'entry' field");
    expect(banner.className).toContain("red");
  });
});
