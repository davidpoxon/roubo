// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import SourceLabel from "./SourceLabel";

describe("SourceLabel (TC-001, TC-018)", () => {
  it("renders 'Bundled' for source=bundled", () => {
    const { getByTestId } = render(<SourceLabel source="bundled" pluginId="github-com" />);
    const label = getByTestId("plugin-source-label");
    expect(label.dataset.source).toBe("bundled");
    expect(label.textContent).toBe("Bundled");
  });

  it("renders monospace path for source=user", () => {
    const { getByTestId } = render(<SourceLabel source="user" pluginId="my-custom-plugin" />);
    const label = getByTestId("plugin-source-label");
    expect(label.dataset.source).toBe("user");
    expect(label.textContent).toBe("~/.roubo/plugins/my-custom-plugin/");
    expect(label.className).toContain("font-mono");
  });
});
