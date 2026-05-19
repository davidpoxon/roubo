// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import FilePathLabel from "./FilePathLabel";

function renderLabel(path: string, className?: string) {
  return render(<FilePathLabel path={path} className={className} />);
}

function querySpan(container: HTMLElement): HTMLSpanElement {
  const el = container.querySelector("span");
  if (!el) throw new Error("expected <span> element");
  return el;
}

describe("FilePathLabel", () => {
  it("renders single segment path (file name only)", () => {
    const { container } = renderLabel("readme.md");
    const outer = querySpan(container);
    expect(outer.getAttribute("title")).toBe("readme.md");
    // Last segment should be visible
    expect(outer.textContent).toContain("readme.md");
  });

  it("renders two-segment path with leading directory", () => {
    const { container } = renderLabel("src/index.ts");
    const outer = querySpan(container);
    expect(outer.getAttribute("title")).toBe("src/index.ts");
    // Should show the leading segment and the file name
    expect(outer.textContent).toContain("src");
    expect(outer.textContent).toContain("index.ts");
  });

  it("renders multi-segment path with truncation indicators", () => {
    const { container } = renderLabel("home/user/projects/app/src/main.ts");
    const outer = querySpan(container);
    expect(outer.getAttribute("title")).toBe("home/user/projects/app/src/main.ts");
    // Should show first segment, ellipsis, and last segment
    expect(outer.textContent).toContain("home");
    expect(outer.textContent).toContain("main.ts");
    // Should contain ellipsis character
    expect(outer.textContent).toContain("\u2026");
  });

  it("applies custom className when provided", () => {
    const { container } = renderLabel("file.ts", "text-lg");
    const outer = querySpan(container);
    expect(outer.className).toContain("text-lg");
  });

  it("applies default text size class when className is not provided", () => {
    const { container } = renderLabel("file.ts");
    const outer = querySpan(container);
    expect(outer.className).toContain("text-[12px]");
  });

  it("applies font-mono class", () => {
    const { container } = renderLabel("file.ts");
    const outer = querySpan(container);
    expect(outer.className).toContain("font-mono");
  });

  it("renders a directory path (no extension) without crashing", () => {
    const { container } = renderLabel("src/components");
    const outer = querySpan(container);
    expect(outer.getAttribute("title")).toBe("src/components");
    expect(outer.textContent).toContain("components");
  });
});
