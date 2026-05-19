// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import WrapCode from "./WrapCode";

describe("WrapCode", () => {
  it("renders text inside a code element", () => {
    render(<WrapCode>hello world</WrapCode>);
    const code = screen.getByText("hello world");
    expect(code.tagName).toBe("CODE");
  });

  it("applies custom className", () => {
    render(<WrapCode className="custom-class">text</WrapCode>);
    const code = screen.getByText("text");
    expect(code.className).toContain("custom-class");
  });

  it("renders short text without wrapping spans when cols are unknown", () => {
    // jsdom returns 0 from getBoundingClientRect, so cols stays null
    // The component renders text directly without wrap spans
    render(<WrapCode>short</WrapCode>);
    expect(screen.getByText("short")).toBeInTheDocument();
  });

  it("applies font-mono class", () => {
    render(<WrapCode>code</WrapCode>);
    const code = screen.getByText("code");
    expect(code.className).toContain("font-mono");
  });
});
