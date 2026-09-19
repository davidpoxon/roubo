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
  it("renders the status-active token for running", () => {
    const dot = renderDot("running");
    expect(dot.className).toContain("bg-status-active");
  });

  it("renders the status-error token for error", () => {
    const dot = renderDot("error");
    expect(dot.className).toContain("bg-status-error");
  });

  it("renders the status-idle token for stopped", () => {
    const dot = renderDot("stopped");
    expect(dot.className).toContain("bg-status-idle");
  });

  it("renders the status-preparing token for starting", () => {
    const dot = renderDot("starting");
    expect(dot.className).toContain("bg-status-preparing");
  });

  it("renders the status-preparing token for stopping", () => {
    const dot = renderDot("stopping");
    expect(dot.className).toContain("bg-status-preparing");
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

  it("names the component and status to assistive technology when labelled", () => {
    const dot = renderDot("error", "api");
    expect(dot.getAttribute("role")).toBe("img");
    expect(dot.getAttribute("aria-label")).toBe("api: error");
  });

  it("is decorative when the caller shows the status as text beside it", () => {
    const dot = renderDot("running");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.getAttribute("role")).toBeNull();
  });
});
