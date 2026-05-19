// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { filePathItems } from "./filePathItems";

describe("filePathItems", () => {
  it("returns an array of SelectItem objects", () => {
    const result = filePathItems(["/repo/src", "/repo/lib"]);
    expect(result).toHaveLength(2);
    expect(result[0].value).toBe("/repo/src");
    expect(result[0].label).toBe("/repo/src");
    expect(result[1].value).toBe("/repo/lib");
  });

  it("each item has a renderLabel that renders a FilePathLabel", () => {
    const result = filePathItems(["/repo/src"]);
    const { container } = render(<>{result[0].renderLabel}</>);
    expect(container.firstChild).toBeTruthy();
  });

  it("returns empty array for empty input", () => {
    expect(filePathItems([])).toHaveLength(0);
  });
});
