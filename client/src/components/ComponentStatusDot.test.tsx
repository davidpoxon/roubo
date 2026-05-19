// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import ComponentStatusDot from "./ComponentStatusDot";
import type { ComponentStatusValue } from "@roubo/shared";

function renderDot(status: ComponentStatusValue, label?: string) {
  const { container } = render(<ComponentStatusDot status={status} label={label} />);
  const el = container.querySelector("span");
  if (!el) throw new Error("expected <span> element");
  return el;
}

describe("ComponentStatusDot", () => {
  it("renders green class for running", () => {
    const dot = renderDot("running");
    expect(dot.className).toContain("bg-green-500");
  });

  it("renders red class for error", () => {
    const dot = renderDot("error");
    expect(dot.className).toContain("bg-red-500");
  });

  it("renders zinc class for stopped", () => {
    const dot = renderDot("stopped");
    expect(dot.className).toContain("bg-stone-600");
  });

  it("renders amber class for starting", () => {
    const dot = renderDot("starting");
    expect(dot.className).toContain("bg-amber-500");
  });

  it("renders amber class for stopping", () => {
    const dot = renderDot("stopping");
    expect(dot.className).toContain("bg-amber-500");
  });

  it("has animate-status-pulse for starting", () => {
    const dot = renderDot("starting");
    expect(dot.className).toContain("animate-status-pulse");
  });

  it("has animate-status-pulse for stopping", () => {
    const dot = renderDot("stopping");
    expect(dot.className).toContain("animate-status-pulse");
  });

  it("does not have animate-status-pulse for running", () => {
    const dot = renderDot("running");
    expect(dot.className).not.toContain("animate-status-pulse");
  });

  it("does not have animate-status-pulse for stopped", () => {
    const dot = renderDot("stopped");
    expect(dot.className).not.toContain("animate-status-pulse");
  });

  it("does not have animate-status-pulse for error", () => {
    const dot = renderDot("error");
    expect(dot.className).not.toContain("animate-status-pulse");
  });

  it("sets title to status when no label provided", () => {
    const dot = renderDot("running");
    expect(dot.getAttribute("title")).toBe("running");
  });

  it("sets title to label: status when label provided", () => {
    const dot = renderDot("running", "Web Server");
    expect(dot.getAttribute("title")).toBe("Web Server: running");
  });
});
