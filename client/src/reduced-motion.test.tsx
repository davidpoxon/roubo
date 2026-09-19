// @vitest-environment jsdom
/// <reference types="node" />
// The client tsconfig pins `types: ["vite/client"]`; this test reads globals.css
// through node:fs (Vitest does not process CSS, so a `?raw` import comes back
// empty), so it references the node types explicitly.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import WaitingBanner from "./components/WaitingBanner";
import ComponentStatusDot from "./components/ComponentStatusDot";

// DESIGN.md §Motion: under prefers-reduced-motion: reduce every keyframe is
// suppressed, and a suppressed status-pulse leaves a static dot beside its
// label. jsdom never matches a media feature query, so the test resolves the
// two motion environments itself: it parses globals.css with jsdom's CSSOM,
// keeps the top-level rules, unwraps the prefers-reduced-motion block that
// matches the environment under test, and drops the other one. The status dot
// is then rendered against that sheet and its computed style is read back.
// jsdom does not expand the `animation` shorthand into its longhands, so the
// assertions read `animation` itself rather than `animation-name`.

const globalsCss = readFileSync(resolve(process.cwd(), "client/src/globals.css"), "utf8");

type MotionPreference = "reduce" | "no-preference";

function parseRules(): CSSRuleList {
  const style = document.createElement("style");
  style.textContent = globalsCss;
  document.head.appendChild(style);
  const rules = (style.sheet as CSSStyleSheet).cssRules;
  style.remove();
  return rules;
}

function mediaRules(preference: MotionPreference): CSSMediaRule[] {
  return Array.from(parseRules()).filter(
    (rule): rule is CSSMediaRule =>
      rule instanceof CSSMediaRule &&
      rule.conditionText.replace(/\s+/g, "") === `(prefers-reduced-motion:${preference})`,
  );
}

// jsdom drops a whole selector list from matching when any member is a
// pseudo-element (`*, *::before, *::after`), so each style rule is re-emitted
// with only its element selectors.
function elementRule(rule: CSSRule): string {
  if (!(rule instanceof CSSStyleRule)) return rule.cssText;
  const selectors = rule.selectorText
    .split(",")
    .map((selector) => selector.trim())
    .filter((selector) => !selector.includes("::"));
  return selectors.length > 0 ? `${selectors.join(", ")} { ${rule.style.cssText} }` : "";
}

function sheetFor(preference: MotionPreference): string {
  const parts: string[] = [];
  for (const rule of Array.from(parseRules())) {
    if (rule instanceof CSSMediaRule) {
      const condition = rule.conditionText.replace(/\s+/g, "");
      if (condition === `(prefers-reduced-motion:${preference})`) {
        parts.push(...Array.from(rule.cssRules, elementRule));
      }
    } else if (rule instanceof CSSStyleRule || rule instanceof CSSKeyframesRule) {
      parts.push(elementRule(rule));
    }
  }
  return parts.join("\n");
}

function applyMotion(preference: MotionPreference): void {
  const style = document.createElement("style");
  style.setAttribute("data-motion", preference);
  style.textContent = sheetFor(preference);
  document.head.appendChild(style);
}

function statusDot(container: HTMLElement): HTMLElement {
  const dot = container.querySelector<HTMLElement>("span.animate-status-pulse");
  if (!dot) throw new Error("status dot not rendered");
  return dot;
}

afterEach(() => {
  cleanup();
  document.head.querySelectorAll("style[data-motion]").forEach((node) => node.remove());
});

describe("reduced motion (DESIGN.md §Motion)", () => {
  it("pulses the status dot when the user has no motion preference", () => {
    applyMotion("no-preference");
    const { container } = render(<WaitingBanner />);
    expect(getComputedStyle(statusDot(container)).animation).toMatch(/^status-pulse\b/);
  });

  it("suppresses the status pulse under reduce and keeps a static dot beside its label", () => {
    applyMotion("reduce");
    const { container } = render(<WaitingBanner />);
    const dot = statusDot(container);
    const computed = getComputedStyle(dot);

    expect(computed.animation).toBe("none");
    expect(computed.display).not.toBe("none");
    expect(computed.visibility).not.toBe("hidden");
    expect(computed.opacity === "" || computed.opacity === "1").toBe(true);

    const label = screen.getByText("Waiting for your input");
    expect(dot.nextElementSibling).toBe(label);
  });

  it("suppresses the transitional component status dot under reduce", () => {
    applyMotion("reduce");
    const { container } = render(<ComponentStatusDot status="starting" label="web" />);
    const dot = statusDot(container);
    expect(getComputedStyle(dot).animation).toBe("none");
    expect(dot).toHaveAttribute("title", "web: starting");
  });

  it("attaches every keyframe only under no-preference and snaps all motion under reduce", () => {
    const [noPreference] = mediaRules("no-preference");
    const attached = Array.from(noPreference.cssRules)
      .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
      .map((rule) => rule.selectorText);
    expect(attached).toEqual(expect.arrayContaining([".animate-status-pulse", ".animate-rise-in"]));

    // No top-level rule attaches an animation outside the gate.
    for (const rule of Array.from(parseRules())) {
      if (rule instanceof CSSStyleRule) {
        expect(rule.style.getPropertyValue("animation")).toBe("");
        expect(rule.style.getPropertyValue("animation-name")).toBe("");
      }
    }

    const [reduce] = mediaRules("reduce");
    const universal = Array.from(reduce.cssRules).find(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && rule.selectorText.includes("*"),
    );
    expect(universal).toBeDefined();
    // Covers Tailwind's animate-spin and every transition utility too.
    expect(universal?.style.getPropertyValue("animation")).toBe("none");
    expect(universal?.style.getPropertyPriority("animation")).toBe("important");
    expect(universal?.style.getPropertyValue("transition-duration")).toBe("0ms");
    expect(universal?.style.getPropertyPriority("transition-duration")).toBe("important");
  });

  it("records rise-in as a 4px rise and no longer ships tab-fade-in", () => {
    const riseIn = Array.from(parseRules()).find(
      (rule): rule is CSSKeyframesRule =>
        rule instanceof CSSKeyframesRule && rule.name === "rise-in",
    );
    expect(riseIn).toBeDefined();
    expect(riseIn?.cssText.replace(/\s+/g, "")).toContain("translateY(4px)");
    expect(globalsCss).not.toContain("tab-fade-in");

    const [noPreference] = mediaRules("no-preference");
    const riseInRule = Array.from(noPreference.cssRules).find(
      (rule): rule is CSSStyleRule =>
        rule instanceof CSSStyleRule && rule.selectorText === ".animate-rise-in",
    );
    expect(riseInRule?.style.getPropertyValue("animation")).toContain(
      "var(--motion-duration-standard)",
    );
    expect(riseInRule?.style.getPropertyValue("animation")).toContain(
      "var(--motion-easing-standard)",
    );
  });
});
