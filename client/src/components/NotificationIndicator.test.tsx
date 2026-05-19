// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import NotificationIndicator from "./NotificationIndicator";
import type { BenchNotification } from "@roubo/shared";

function makeNotification(
  priority: BenchNotification["priority"],
  type: BenchNotification["type"] = "claude-waiting",
): BenchNotification {
  return { id: crypto.randomUUID(), type, priority, createdAt: new Date().toISOString() };
}

function renderIndicator(notifications: BenchNotification[]) {
  const { container } = render(<NotificationIndicator notifications={notifications} />);
  return container.querySelector("span");
}

function getSpan(notifications: BenchNotification[]): HTMLSpanElement {
  const el = renderIndicator(notifications);
  if (!el) throw new Error("expected <span> element");
  return el;
}

describe("NotificationIndicator", () => {
  it("renders nothing when notifications array is empty", () => {
    expect(renderIndicator([])).toBeNull();
  });

  it("renders amber-500 for action-needed notifications", () => {
    const el = getSpan([makeNotification("action-needed")]);
    expect(el.className).toContain("bg-amber-500");
  });

  it("renders stone-400 for info-only notifications", () => {
    const el = getSpan([makeNotification("info", "bench-ready")]);
    expect(el.className).toContain("bg-stone-400");
  });

  it("renders amber-500 when mixed priorities (amber wins)", () => {
    const el = getSpan([
      makeNotification("info", "bench-ready"),
      makeNotification("action-needed", "bench-error"),
    ]);
    expect(el.className).toContain("bg-amber-500");
    expect(el.className).not.toContain("bg-stone-400");
  });

  it('has role="img" for screen reader accessibility', () => {
    const el = getSpan([makeNotification("action-needed")]);
    expect(el.getAttribute("role")).toBe("img");
  });

  it('has aria-label "Action needed" for action-needed priority', () => {
    const el = getSpan([makeNotification("action-needed")]);
    expect(el.getAttribute("aria-label")).toBe("Action needed");
  });

  it('has aria-label "Notification" for info priority', () => {
    const el = getSpan([makeNotification("info", "bench-ready")]);
    expect(el.getAttribute("aria-label")).toBe("Notification");
  });

  it("has animate-status-pulse for action-needed", () => {
    const el = getSpan([makeNotification("action-needed")]);
    expect(el.className).toContain("animate-status-pulse");
  });

  it("does not have animate-status-pulse for info-only", () => {
    const el = getSpan([makeNotification("info", "bench-ready")]);
    expect(el.className).not.toContain("animate-status-pulse");
  });
});
