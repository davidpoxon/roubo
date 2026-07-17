// @vitest-environment jsdom
//
// Tests for the shared expectNoAxeFindings helper (issue
// roubo-development#600), including a repro pinning the axe-core behavior
// behind the blind spot it closes: a prohibited aria-label on a role-less
// element with subtree text is downgraded to results.incomplete, which the
// bare toHaveNoViolations matcher silently ignores.

import { describe, it, expect } from "vitest";
import { axe } from "vitest-axe";
import type { AxeCore } from "vitest-axe";
import { expectNoAxeFindings, FAILING_INCOMPLETE_RULES } from "./axe";

function result(id: string, over: Partial<AxeCore.Result> = {}): AxeCore.Result {
  return {
    id,
    impact: "serious",
    description: `Description for ${id}`,
    help: `Help for ${id}`,
    helpUrl: `https://dequeuniversity.com/rules/axe/4.12/${id}`,
    tags: [],
    nodes: [
      {
        html: '<span aria-label="x">x</span>',
        target: ["span[aria-label]"],
        any: [],
        all: [],
        none: [],
        failureSummary: `Fix: ${id}`,
      },
    ],
    ...over,
  } as AxeCore.Result;
}

function results(over: Partial<AxeCore.AxeResults> = {}): AxeCore.AxeResults {
  return {
    violations: [],
    incomplete: [],
    passes: [],
    inapplicable: [],
    ...over,
  } as unknown as AxeCore.AxeResults;
}

describe("expectNoAxeFindings", () => {
  it("passes on a clean results object", () => {
    expect(() => expectNoAxeFindings(results())).not.toThrow();
  });

  it("fails on violations, like the underlying matcher", () => {
    const dirty = results({ violations: [result("aria-hidden-focus")] });
    expect(() => expectNoAxeFindings(dirty)).toThrow(/aria-hidden-focus/);
  });

  it("fails on an incomplete result whose rule is in the curated list", () => {
    const dirty = results({ incomplete: [result("aria-prohibited-attr")] });
    expect(() => expectNoAxeFindings(dirty)).toThrow(
      /incomplete result\(s\) matched curated failing rules/,
    );
    // The failure names the rule and the offending node's target selector.
    expect(() => expectNoAxeFindings(dirty)).toThrow(/aria-prohibited-attr/);
    expect(() => expectNoAxeFindings(dirty)).toThrow(/span\[aria-label\]/);
  });

  it("ignores incomplete results for rules outside the curated list", () => {
    // color-contrast is axe's canonical "needs human review" incomplete: jsdom
    // cannot resolve backgrounds, so failing on it would be pure noise.
    const ambiguous = results({ incomplete: [result("color-contrast")] });
    expect(() => expectNoAxeFindings(ambiguous)).not.toThrow();
  });

  it("curates aria-prohibited-attr", () => {
    expect(FAILING_INCOMPLETE_RULES).toContain("aria-prohibited-attr");
  });
});

describe("axe-core downgrade behind the blind spot (roubo#965)", () => {
  it("parks a prohibited aria-label with subtree text in results.incomplete, and the helper fails on it", async () => {
    // The exact shape SourceChip had before roubo#965: a role-less <span>
    // (ARIA role `generic`, which prohibits aria-label) carrying both an
    // aria-label and subtree text. axe-core downgrades this from violation to
    // incomplete because the subtree text means assistive tech may still
    // announce something.
    const container = document.createElement("div");
    container.innerHTML = '<span aria-label="ACME workplace">ACME workplace</span>';
    document.body.appendChild(container);
    try {
      const scan = await axe(container);

      // Pin the downgrade: the finding lands in incomplete, NOT violations,
      // which is exactly why bare toHaveNoViolations kept the suite green.
      expect(scan.violations.map((v) => v.id)).not.toContain("aria-prohibited-attr");
      expect(scan.incomplete.map((i) => i.id)).toContain("aria-prohibited-attr");
      expect(scan).toHaveNoViolations();

      // The helper sees what the matcher does not.
      expect(() => expectNoAxeFindings(scan)).toThrow(/aria-prohibited-attr/);
    } finally {
      container.remove();
    }
  });

  it("passes the helper once the prohibited attribute is removed (the roubo#965 shape)", async () => {
    const container = document.createElement("div");
    container.innerHTML = '<span><span class="sr-only">Source: </span>ACME workplace</span>';
    document.body.appendChild(container);
    try {
      const scan = await axe(container);
      expect(() => expectNoAxeFindings(scan)).not.toThrow();
    } finally {
      container.remove();
    }
  });
});
