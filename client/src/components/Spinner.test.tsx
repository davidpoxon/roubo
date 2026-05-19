// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import Spinner from "./Spinner";

describe("Spinner", () => {
  it("renders a div with spinner classes", () => {
    const { container } = render(<Spinner />);
    const div = container.firstChild as HTMLElement;
    expect(div.tagName).toBe("DIV");
    expect(div.className).toContain("animate-spin");
    expect(div.className).toContain("rounded-full");
  });
});
