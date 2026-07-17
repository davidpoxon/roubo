// Shared axe-core assertion helper for the client a11y suites (issue
// roubo-development#600).
//
// vitest-axe's `toHaveNoViolations` matcher only inspects `results.violations`.
// axe-core downgrades some real defects to `results.incomplete` ("needs
// review"), notably `aria-prohibited-attr` when the element carries subtree
// text: a prohibited `aria-label` on a role-less span sat invisible behind a
// green suite until davidpoxon/roubo#965 removed it by hand. This helper closes
// that blind spot: it asserts `toHaveNoViolations()` AND fails on any
// `results.incomplete` entry whose rule id is in the curated list below.
//
// The list is deliberately curated rather than a blanket fail on all
// `incomplete`: axe parks genuinely ambiguous checks there (e.g. color-contrast
// on unresolvable backgrounds) that need human review, and failing on those
// would make the suites too noisy to keep green. Add a rule id here only when
// an `incomplete` result for it is a real defect in a jsdom render, never an
// artifact of the environment.
import { expect } from "vitest";
// vitest-axe@0.1.0 mis-declares its top-level `matchers` entry as a `export type *`
// re-export, so the runtime value disappears in TS. The dist path is unaffected.
import { toHaveNoViolations } from "vitest-axe/dist/matchers.js";
import type { AxeCore } from "vitest-axe";

declare module "vitest" {
  interface Assertion {
    toHaveNoViolations: () => void;
  }
}

expect.extend({ toHaveNoViolations });

/**
 * Incomplete-result rule ids that are treated as hard failures. For these
 * rules, "needs review" in a deterministic jsdom render is a defect, not an
 * ambiguity.
 */
export const FAILING_INCOMPLETE_RULES: readonly string[] = ["aria-prohibited-attr"];

function formatIncomplete(findings: AxeCore.Result[]): string {
  return findings
    .map((finding) => {
      const nodes = finding.nodes.map((node) => `    - ${node.target.join(", ")}`).join("\n");
      return `  ${finding.id}: ${finding.description}\n${nodes}`;
    })
    .join("\n");
}

/**
 * Assert an axe scan produced no findings: no `violations`, and no
 * `incomplete` results for the curated rules in FAILING_INCOMPLETE_RULES.
 * Use this in place of a bare `expect(results).toHaveNoViolations()`.
 */
export function expectNoAxeFindings(results: AxeCore.AxeResults): void {
  expect(results).toHaveNoViolations();
  const failing = results.incomplete.filter((finding) =>
    FAILING_INCOMPLETE_RULES.includes(finding.id),
  );
  if (failing.length > 0) {
    throw new Error(
      `Expected no axe findings, but ${failing.length} incomplete result(s) matched ` +
        `curated failing rules (axe downgrades these to "needs review", we treat them ` +
        `as violations):\n${formatIncomplete(failing)}`,
    );
  }
}
