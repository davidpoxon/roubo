import { describe, it, expect } from "vitest";
import { canonicalize } from "./testbench-canonicalize.js";
import type { TestCasesPlan } from "./testbench-domain-types.js";

// spike-407 AC2 worked example. Input A is compact; Input B is pretty/CRLF/
// reordered-keys/padded-whitespace. Both must canonicalise to the EXACT string
// at spike-407 line 139.
const EXPECTED_AC2 =
  '{"cases":[{"id":"TC-002","title":"Create TestBench option is absent when disabled","level":"1","priority":"P0","steps":[{"id":"S1","instruction":"Open the option menu on an empty bench slot","observations":[{"id":"O1","expected":"\'Create a TestBench\' option is NOT present"}]}]}]}';

const inputA: TestCasesPlan = {
  $schema: "...",
  schemaVersion: "1.0.0",
  specSlug: "testbench",
  cases: [
    {
      id: "TC-002",
      title: "Create TestBench option is absent when disabled",
      level: "1",
      priority: "P0",
      steps: [
        {
          id: "S1",
          instruction: "Open the option menu on an empty bench slot",
          observations: [{ id: "O1", expected: "'Create a TestBench' option is NOT present" }],
        },
      ],
    },
  ],
};

// Input B: reordered top-level keys, CRLF + doubled internal spaces in title,
// reordered per-object keys, trailing newline in a string value.
const inputB: TestCasesPlan = {
  schemaVersion: "1.0.0",
  specSlug: "testbench",
  $schema: "...",
  cases: [
    {
      title: "Create   TestBench option   is absent when disabled\r\n",
      id: "TC-002",
      priority: "P0",
      level: "1",
      steps: [
        {
          id: "S1",
          observations: [{ expected: "'Create a TestBench' option is NOT present", id: "O1" }],
          instruction: "Open the option menu on an empty bench slot",
        },
      ],
    },
  ],
} as TestCasesPlan;

describe("canonicalize (spike-407 AC1/AC2)", () => {
  it("Input A produces the exact AC2 canonical string", () => {
    expect(canonicalize(inputA)).toBe(EXPECTED_AC2);
  });

  it("TC-045: Input B (whitespace/formatting/key-order variant) canonicalises identically to Input A", () => {
    expect(canonicalize(inputB)).toBe(canonicalize(inputA));
    expect(canonicalize(inputB)).toBe(EXPECTED_AC2);
  });

  it("a genuine content change (observation.expected) produces a DIFFERENT string", () => {
    const changed: TestCasesPlan = {
      ...inputA,
      cases: [
        {
          ...inputA.cases[0],
          steps: [
            {
              ...inputA.cases[0].steps[0],
              observations: [{ id: "O1", expected: "'Create a TestBench' option IS present" }],
            },
          ],
        },
      ],
    };
    expect(canonicalize(changed)).not.toBe(canonicalize(inputA));
  });

  it("drops $schema, schemaVersion, specSlug, and TargetingFields from the hash input", () => {
    const withExtras: TestCasesPlan = {
      $schema: "DIFFERENT-SCHEMA",
      schemaVersion: "9.9.9",
      specSlug: "a-renamed-slug",
      cases: [
        {
          id: "TC-002",
          title: "Create TestBench option is absent when disabled",
          level: "1",
          priority: "P0",
          steps: [
            {
              id: "S1",
              instruction: "Open the option menu on an empty bench slot",
              target: { cssSelector: "#menu" },
              observations: [
                {
                  id: "O1",
                  expected: "'Create a TestBench' option is NOT present",
                  observe: { ariaRole: "menuitem" },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(canonicalize(withExtras)).toBe(EXPECTED_AC2);
  });

  it("stable-id sort: out-of-order cases/steps/observations canonicalise identically to sorted", () => {
    const sorted: TestCasesPlan = {
      $schema: "x",
      schemaVersion: "1.0.0",
      specSlug: "testbench",
      cases: [
        {
          id: "TC-001",
          title: "First",
          level: "1",
          priority: "P0",
          steps: [
            {
              id: "S1",
              instruction: "Step one",
              observations: [
                { id: "O1", expected: "Obs one" },
                { id: "O2", expected: "Obs two" },
              ],
            },
            { id: "S2", instruction: "Step two", observations: [{ id: "O1", expected: "Obs" }] },
          ],
        },
        { id: "TC-002", title: "Second", level: "1", priority: "P1", steps: [] },
      ],
    };
    const shuffled: TestCasesPlan = {
      $schema: "x",
      schemaVersion: "1.0.0",
      specSlug: "testbench",
      cases: [
        { id: "TC-002", title: "Second", level: "1", priority: "P1", steps: [] },
        {
          id: "TC-001",
          title: "First",
          level: "1",
          priority: "P0",
          steps: [
            { id: "S2", instruction: "Step two", observations: [{ id: "O1", expected: "Obs" }] },
            {
              id: "S1",
              instruction: "Step one",
              observations: [
                { id: "O2", expected: "Obs two" },
                { id: "O1", expected: "Obs one" },
              ],
            },
          ],
        },
      ],
    };
    expect(canonicalize(shuffled)).toBe(canonicalize(sorted));
  });

  it("NFC normalisation: decomposed and composed forms collapse to the same string", () => {
    const composed: TestCasesPlan = {
      $schema: "x",
      schemaVersion: "1.0.0",
      specSlug: "testbench",
      // U+00E9 (composed 'é')
      cases: [{ id: "TC-1", title: "café", level: "1", priority: "P0", steps: [] }],
    };
    const decomposed: TestCasesPlan = {
      $schema: "x",
      schemaVersion: "1.0.0",
      specSlug: "testbench",
      // 'e' + U+0301 (combining acute accent)
      cases: [{ id: "TC-1", title: "café", level: "1", priority: "P0", steps: [] }],
    };
    expect(canonicalize(decomposed)).toBe(canonicalize(composed));
  });

  it("absent and empty preconditions canonicalise identically (and omit the key)", () => {
    const absent: TestCasesPlan = {
      $schema: "x",
      schemaVersion: "1.0.0",
      specSlug: "testbench",
      cases: [{ id: "TC-1", title: "T", level: "1", priority: "P0", steps: [] }],
    };
    const empty: TestCasesPlan = {
      $schema: "x",
      schemaVersion: "1.0.0",
      specSlug: "testbench",
      cases: [{ id: "TC-1", title: "T", level: "1", priority: "P0", preconditions: [], steps: [] }],
    };
    expect(canonicalize(empty)).toBe(canonicalize(absent));
    expect(canonicalize(absent)).not.toContain("preconditions");
  });

  it("preconditions order is preserved (not sorted)", () => {
    const plan = (preconditions: string[]): TestCasesPlan => ({
      $schema: "x",
      schemaVersion: "1.0.0",
      specSlug: "testbench",
      cases: [{ id: "TC-1", title: "T", level: "1", priority: "P0", preconditions, steps: [] }],
    });
    expect(canonicalize(plan(["beta", "alpha"]))).not.toBe(canonicalize(plan(["alpha", "beta"])));
  });

  it("empty case set canonicalises to a fixed, stable, non-empty string", () => {
    const emptyPlan: TestCasesPlan = {
      $schema: "x",
      schemaVersion: "1.0.0",
      specSlug: "testbench",
      cases: [],
    };
    expect(canonicalize(emptyPlan)).toBe('{"cases":[]}');
  });
});
