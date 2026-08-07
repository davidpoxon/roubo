import {
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
  type CaseLifecycle,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import {
  WORK_UNITS_SCHEMA_ID,
  WORK_UNITS_SCHEMA_VERSION,
  type WorkUnitsFile,
} from "@roubo/shared/work-units-contract";

// TC-001 (#438): the authoritative `e2e_flow` case the create-a-TestBench journey
// drift-guards against. This is the schema-valid (TestCasesPlanSchema) projection
// of `.specifications/testbench/test-cases.json` TC-001: the same id, title,
// preconditions, and step-by-step expectations, expressed as the TestBench plan
// shape `discoverSpecs` / the plan reader validate. The e2e spec seeds this into
// the fixture repo, then asserts the integrated journey matches it end to end
// (AC6). Keeping the case here, beside the spec, makes the drift-guard explicit:
// if TC-001's journey changes, this object and the spec move together.
export const TESTBENCH_SPEC_SLUG = "testbench";

export const TC_001_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TESTBENCH_SPEC_SLUG,
  cases: [
    {
      id: "TC-001",
      title: "Create a TestBench from an empty bench slot using a discovered spec",
      area: "bench-variant",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
      preconditions: [
        "TestBench feature is enabled in settings",
        "At least one bench slot is empty",
        "The focused project repo contains at least one file matching .specifications/*/test-cases.json",
        "User is on the bench list view for the project",
      ],
      steps: [
        {
          id: "TC-001-S1",
          instruction: "Open the option menu on an empty bench slot",
          observations: [
            { id: "TC-001-S1-O1", expected: "'Create a TestBench' option is present in the menu" },
          ],
        },
        {
          id: "TC-001-S2",
          instruction: "Click 'Create a TestBench' from the option menu",
          observations: [{ id: "TC-001-S2-O1", expected: "Spec-picker modal opens" }],
        },
        {
          id: "TC-001-S3",
          instruction: "Observe the discovered-specs list in the modal",
          observations: [
            {
              id: "TC-001-S3-O1",
              expected: "Each discovered spec row shows slug, file path, and case count",
            },
            {
              id: "TC-001-S3-O2",
              expected:
                "At least one row matches a .specifications/*/test-cases.json file in the repo",
            },
          ],
        },
        {
          id: "TC-001-S4",
          instruction: "Click a spec row to select it",
          observations: [
            { id: "TC-001-S4-O1", expected: "Row is highlighted as selected" },
            { id: "TC-001-S4-O2", expected: "Create button becomes enabled" },
          ],
        },
        {
          id: "TC-001-S5",
          instruction: "Click the Create button",
          observations: [
            { id: "TC-001-S5-O1", expected: "Modal closes" },
            {
              id: "TC-001-S5-O2",
              expected: "Bench is created with a worktree bound to the selected spec",
            },
            { id: "TC-001-S5-O3", expected: "Bench detail view opens" },
          ],
        },
        {
          id: "TC-001-S6",
          instruction: "Observe the tabs in the bench detail view",
          observations: [
            {
              id: "TC-001-S6-O1",
              expected: "A 'TestBench' tab is the first tab with an amber accent dot",
            },
            {
              id: "TC-001-S6-O2",
              expected: "Standard tabs (Components, Terminal, Info) are also present",
            },
            { id: "TC-001-S6-O3", expected: "Inspection tab is present if previously configured" },
          ],
        },
        {
          id: "TC-001-S7",
          instruction: "Click the TestBench tab",
          observations: [
            { id: "TC-001-S7-O1", expected: "TestBench content loads" },
            { id: "TC-001-S7-O2", expected: "The focused spec slug and path are displayed" },
            { id: "TC-001-S7-O3", expected: "The results panel is visible" },
          ],
        },
      ],
    },
  ],
};

// TC-006 (#443): the authoritative `e2e_flow` case the
// "create-a-TestBench from a valid manual file path" journey drift-guards
// against. This is the schema-valid (TestCasesPlanSchema) projection of
// `.specifications/testbench/test-cases.json` TC-006: the same id, title, and
// step-by-step expectations, expressed as the TestBench plan shape
// `discoverSpecs` / the plan reader validate. The manual-path spec seeds this
// into the fixture repo (under the same `testbench` slug, so the typed
// `.specifications/testbench/test-cases.json` path resolves to it), then asserts
// the integrated manual-path journey matches it end to end (AC4). Keeping the
// case here, beside the spec, makes the drift-guard explicit: if TC-006's
// journey changes, this object and the spec move together.
export const TC_006_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TESTBENCH_SPEC_SLUG,
  cases: [
    {
      id: "TC-006",
      title: "Create a TestBench with a valid manual file path",
      area: "bench-variant",
      level: 2,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["FR-003"],
      linked_user_story_ids: [],
      preconditions: [
        "TestBench feature is enabled",
        "An empty bench slot exists",
        "A valid test-cases.json exists at a known path within the registered project repo",
        "User has opened the Create a TestBench modal",
      ],
      steps: [
        {
          id: "TC-006-S1",
          instruction: "Locate the manual-path input field in the modal",
          observations: [
            { id: "TC-006-S1-O1", expected: "The 'Or enter a path' input is present in the modal" },
          ],
        },
        {
          id: "TC-006-S2",
          instruction: "Type a valid path to a test-cases.json within the project repo",
          observations: [
            {
              id: "TC-006-S2-O1",
              expected: "Input shows a validating indicator while the path is validated",
            },
          ],
        },
        {
          id: "TC-006-S3",
          instruction: "Wait for validation to complete",
          observations: [
            { id: "TC-006-S3-O1", expected: "Input shows a green check (valid state)" },
            { id: "TC-006-S3-O2", expected: "Create button becomes enabled" },
            { id: "TC-006-S3-O3", expected: "No error message is shown" },
          ],
        },
        {
          id: "TC-006-S4",
          instruction: "Click the Create button",
          observations: [
            { id: "TC-006-S4-O1", expected: "Modal closes" },
            {
              id: "TC-006-S4-O2",
              expected: "TestBench is created bound to the manually specified spec",
            },
            {
              id: "TC-006-S4-O3",
              expected: "Bench detail opens with the TestBench tab showing the correct spec path",
            },
          ],
        },
      ],
    },
  ],
};

// The slices that own each leg of this journey, surfaced in a failing run so the
// divergence localises to an attributable slice (FR-020 / AC7). The mapping is
// the create-a-TestBench work units' `blocked_by` / `covers` set (issues #438
// for TC-001, #443 for TC-006):
//   #414 settings toggle (TestBench enablement),
//   #416 bench-variant create (worktree binding + variant tab surface),
//   #418 create-a-TestBench flow (empty-slot option + spec-picker + manual-path
//        escape hatch + live validation, FR-003),
//   #419 TestBench review tab (focused slug/path + results panel).
export const OWNING_SLICES: Record<string, string> = {
  enable: "#414 (TestBench settings toggle)",
  emptySlotMenu: "#418 (create-a-TestBench flow: empty-slot option)",
  specPicker: "#418 (create-a-TestBench flow: spec-picker modal)",
  discoveredRow: "#418 (create-a-TestBench flow: spec discovery)",
  manualPathInput: "#418 (create-a-TestBench flow: manual-path escape hatch)",
  manualPathValidation: "#418 (create-a-TestBench flow: live manual-path validation, FR-003)",
  createBinding: "#416 (bench-variant create: spec-bound worktree)",
  variantTabs: "#416 (bench-variant create: TestBench-first tab surface)",
  reviewPanel: "#419 (TestBench review tab: focused slug/path + results panel)",
};

// TC-069 (#441): the authoritative `e2e_flow` case the toggle-off-and-on journey
// drift-guards against, restated verbatim from `.specifications/testbench/test-cases.json`
// TC-069 (id, title, preconditions, and per-step expected observations). The e2e
// spec walks each leg against this object so a journey change moves the case and
// the spec together. Unlike TC_001_PLAN this is NOT seeded into a fixture repo
// (the journey never discovers specs or creates a bench), so it is kept as a
// plain documentation object rather than a schema-valid TestCasesPlan.
export const TC_069 = {
  id: "TC-069",
  title: "E2E: toggle TestBench off, verify hidden, toggle on, verify restored",
  area: "settings",
  type: "e2e_flow",
  preconditions: [
    "Roubo is running",
    "TestBench is enabled (toggle ON)",
    "The main UI shows the create-TestBench option and surface",
  ],
  steps: [
    { action: "Open app settings" },
    { action: "Navigate to the 'TestBench' tab" },
    {
      action: "Observe the switch state",
      expected: ["Switch is ON (amber) with no disabled helper text"],
    },
    {
      action: "Click the switch to toggle OFF",
      expected: ["Switch turns OFF", "The disabled helper text appears"],
    },
    {
      action: "Close app settings and inspect the main UI",
      expected: [
        "The create-TestBench option is absent",
        "The TestBench surface is not accessible",
      ],
    },
    {
      action: "Re-open settings, navigate to the 'TestBench' tab, and toggle ON",
      expected: ["Switch turns ON", "The disabled helper text is removed"],
    },
    {
      action: "Close settings and inspect the main UI",
      expected: [
        "The create-TestBench option is visible again",
        "The TestBench feature surface is accessible again",
      ],
    },
  ],
} as const;

// The slices that own each leg of the TC-069 journey, surfaced in a failing run so
// the divergence localises to an attributable slice (FR-020 / AC6). The mapping is
// this work unit's `blocked_by` / `covers` set from issue #441:
//   #414 the app-settings TestBench tab + enable toggle,
//   #416 the bench-variant wiring that derives the gated surface from the toggle,
//   #417 the UserPreferences testBench.enabled persistence the toggle round-trips,
//   #418 the create-a-TestBench entry point gated on the toggle.
export const TC_069_OWNING_SLICES = {
  toggle: "#414 (app-settings TestBench tab + enable toggle)",
  helperText: "#414 (app-settings TestBench tab: disabled helper text)",
  persistence: "#417 (UserPreferences testBench.enabled persistence)",
  gatedSurface: "#418 (create-a-TestBench entry point gated on the toggle)",
  surfaceWiring: "#416 (bench-variant wiring: testBenchEnabled derived from settings)",
} as const;

// TC-007 (#444): the authoritative `e2e_flow` case the re-point journey
// drift-guards against. The journey re-points a TestBench from spec-A to spec-B
// and back, asserting per-spec result isolation. Two distinct plans are seeded
// into the one fixture repo so isolation is observable: spec-A (TC_007_PLAN_A)
// carries the case the test records a result against; spec-B (TC_007_PLAN_B) is
// a different spec with a distinct slug and distinct case ids, so spec-B's case
// ids never appear in spec-A's preserved result set (AC3). These are schema-valid
// (TestCasesPlanSchema) projections of `.specifications/testbench/test-cases.json`
// TC-007 expressed as TestBench plan objects; keeping them here, beside TC-001,
// makes the drift guard explicit.
export const TC_007_SPEC_A_SLUG = "repoint-spec-a";
export const TC_007_SPEC_B_SLUG = "repoint-spec-b";

export const TC_007_PLAN_A: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TC_007_SPEC_A_SLUG,
  cases: [
    {
      id: "TC-A01",
      title: "Spec-A: the case a result is recorded against before the re-point",
      area: "repoint",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["FR-024"],
      linked_user_story_ids: [],
      preconditions: ["A TestBench is bound to spec-A"],
      steps: [
        {
          id: "TC-A01-S1",
          instruction: "Perform the spec-A check",
          observations: [{ id: "TC-A01-S1-O1", expected: "Spec-A behaves as specified" }],
        },
      ],
    },
  ],
};

export const TC_007_PLAN_B: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TC_007_SPEC_B_SLUG,
  cases: [
    {
      id: "TC-B01",
      title: "Spec-B: a distinct case that must never bleed into spec-A's results",
      area: "repoint",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["FR-024"],
      linked_user_story_ids: [],
      preconditions: ["Spec-B is discoverable in the same project repo"],
      steps: [
        {
          id: "TC-B01-S1",
          instruction: "Perform the spec-B check",
          observations: [{ id: "TC-B01-S1-O1", expected: "Spec-B behaves as specified" }],
        },
      ],
    },
  ],
};

// The slices that own each leg of the re-point journey, surfaced in a failing
// run so the divergence localises to an attributable slice (FR-020 / AC5). The
// mapping is this work unit's `blocked_by` set from issue #444:
//   #414 settings toggle (TestBench enablement),
//   #416 bench-variant create (spec-bound worktree + variant tab surface),
//   #423 re-point (header "Change focused spec" action + spec-picker repoint
//        mode + per-spec results reload).
export const OWNING_SLICES_TC007: Record<string, string> = {
  enable: "#414 (TestBench settings toggle)",
  createBinding: "#416 (bench-variant create: spec-bound worktree)",
  reviewPanel: "#416 (bench-variant create: TestBench tab surface + results panel)",
  repointAction: "#423 (re-point: 'Change focused spec' header action)",
  specPicker: "#423 (re-point: spec-picker in repoint mode with active-spec marker)",
  resultsIsolation: "#423 (re-point: per-spec results reload + isolation)",
};

// ─────────────────────────────────────────────────────────────────────────────
// TC-043 (#440): the authoritative `e2e_flow` case the persist -> staleness ->
// reconcile journey drift-guards against. The journey spans:
//   #406 atomic/EXDEV-safe sidecar write,
//   #407 canonical staleness hash + orphan-not-delete reconcile spike,
//   #412 mark observations / derived status,
//   #413 reconcile algorithm (added/changed/orphan classification),
//   #415 sidecar store (fail-open read, persist, planHash),
//   #416 TestBench REST routes,
//   #422 staleness banner + reconcile dialog UI.
// This work unit (#440) is the integration-level drift guard: it asserts the
// integrated journey end to end, not any single slice's implementation. The
// highest-risk invariant is NFR-003: no authored mark or note is ever lost.
// ─────────────────────────────────────────────────────────────────────────────

// The initial three-case plan seeded before any results exist. TC-A, TC-B, TC-C
// each carry a single observation so the e2e spec can mark each case pass/fail
// from the case detail pane. All three sit at the same level/priority so they
// group together in the rollup.
export const TC_043_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TESTBENCH_SPEC_SLUG,
  cases: [
    {
      id: "TC-A",
      title: "Landing page renders",
      area: "demo",
      level: 1,
      type: "functional",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
      steps: [
        {
          id: "TC-A-S1",
          instruction: "Open the landing page",
          observations: [{ id: "TC-A-S1-O1", expected: "The hero section is visible" }],
        },
      ],
    },
    {
      id: "TC-B",
      title: "Sign-in redirect works",
      area: "demo",
      level: 1,
      type: "functional",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
      steps: [
        {
          id: "TC-B-S1",
          instruction: "Click sign in",
          observations: [{ id: "TC-B-S1-O1", expected: "The user is redirected to the dashboard" }],
        },
      ],
    },
    {
      id: "TC-C",
      title: "Settings page saves",
      area: "demo",
      level: 1,
      type: "functional",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
      steps: [
        {
          id: "TC-C-S1",
          instruction: "Save the settings form",
          observations: [{ id: "TC-C-S1-O1", expected: "A success toast appears" }],
        },
      ],
    },
  ],
};

// The post-edit plan written mid-test: TC-B is removed and TC-D is added, while
// TC-A and TC-C are carried over byte-identical. Reconcile must therefore report
// TC-D as Added and TC-B as Orphaned, and TC-A / TC-C remain active with their
// recorded pass marks. This is the source `test-cases.json` the rewrite endpoint
// overwrites; its checksum is snapshotted afterwards and must be unchanged by the
// reconcile Apply (reconcile only ever writes test-results.json, never the plan).
export const TC_043_PLAN_AFTER_EDIT: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TESTBENCH_SPEC_SLUG,
  cases: [
    TC_043_PLAN.cases[0], // TC-A, unchanged
    TC_043_PLAN.cases[2], // TC-C, unchanged
    {
      id: "TC-D",
      title: "Logout clears the session",
      area: "demo",
      level: 1,
      type: "functional",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["FR-001"],
      linked_user_story_ids: [],
      steps: [
        {
          id: "TC-D-S1",
          instruction: "Click log out",
          observations: [{ id: "TC-D-S1-O1", expected: "The session is cleared" }],
        },
      ],
    },
  ],
};

// The slices that own each leg of the persist -> staleness -> reconcile journey,
// surfaced in a failing run so the divergence localises to an attributable slice
// (FR-020 / AC7). The mapping is this work unit's `blocked_by` / `covers` set
// from issue #440.
export const TC_043_OWNING_SLICES: Record<string, string> = {
  enable: "#414 (TestBench settings toggle)",
  create: "#416/#418 (create-a-TestBench flow + spec-bound worktree)",
  reviewPanel: "#419 (TestBench review tab: focused slug/path + results panel)",
  marks: "#412/#415 (mark observations + sidecar persist)",
  notes: "#415 (notes persisted in the sidecar)",
  persist: "#406/#415 (atomic sidecar write + fail-open re-read)",
  staleness: "#407/#415/#422 (canonical staleness hash + amber banner)",
  reconcile: "#413/#422 (reconcile classification + dialog)",
  apply: "#413/#422 (apply reconcile: orphan-not-delete)",
  integrity: "#406/#413 (NFR-003: archived results retained, source plan unchanged)",
};

// ─────────────────────────────────────────────────────────────────────────────
// TSPF-TC-010 (#486): the authoritative `e2e_flow` case the "create a TestBench
// from the PARTITIONED picker, selecting an all-passed spec from the disclosure"
// journey drift-guards against. Restated from
// `.specifications/testbench-spec-picker-filter/test-cases.json` TSPF-TC-010: the
// same id, preconditions, and per-step expected observations (S001-S005). The
// journey spans this work unit's blocked-by set:
//   #482 discovery aggregation (per-spec verification + classification),
//   #483 partitioned spec picker (needs-attention main space + collapsed
//        all-passed disclosure + per-row pass-state summaries + cross-group
//        single selection),
//   #484 empty-state / a11y slice (the main space when every spec is all-passed;
//        a conservative superset member, its empty state must NOT fire here).
//
// The one genuinely new fixture mechanism the journey needs: the picker can only
// be partitioned when the repo carries BOTH a needs-attention spec AND an
// all-passed spec. Discovery classifies a spec all-passed only when a readable,
// schema-valid, PLAN-HASH-MATCHING test-results.json is present with every case
// passed, so the two plans below are seeded with `seedResults` (server-side
// sidecar synthesis, scenario.ts / test.ts) rather than a hand-rolled sidecar.
// ─────────────────────────────────────────────────────────────────────────────

// The needs-attention spec: two cases so a "partial" results seed (first case
// passed, second not) reads as a real "1 of 2 passed" per-row summary (S002-O03)
// and the spec stays needs-attention (passed != caseCount), filling the main
// space (S002-O01).
export const TSPF_TC_010_NEEDS_ATTENTION_SLUG = "partitioned-needs-attention";

export const TSPF_TC_010_NEEDS_ATTENTION_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TSPF_TC_010_NEEDS_ATTENTION_SLUG,
  cases: [
    {
      id: "TC-NA1",
      title: "Needs-attention spec: a passed case",
      area: "spec-picker",
      level: 1,
      type: "functional",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-006"],
      linked_user_story_ids: [],
      preconditions: ["The spec has a partial results sidecar"],
      steps: [
        {
          id: "TC-NA1-S1",
          instruction: "Perform the passed check",
          observations: [{ id: "TC-NA1-S1-O1", expected: "It passes" }],
        },
      ],
    },
    {
      id: "TC-NA2",
      title: "Needs-attention spec: a not-yet-run case",
      area: "spec-picker",
      level: 1,
      type: "functional",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-006"],
      linked_user_story_ids: [],
      preconditions: ["The spec has a partial results sidecar"],
      steps: [
        {
          id: "TC-NA2-S1",
          instruction: "Perform the not-yet-run check",
          observations: [{ id: "TC-NA2-S1-O1", expected: "Not run yet" }],
        },
      ],
    },
  ],
};

// The all-passed spec: three cases, all seeded passed, so discovery classifies it
// all-passed (it is relegated to the collapsed disclosure, S002-O02/O04) and each
// row reads "All 3 passed" once revealed (S003-O02).
export const TSPF_TC_010_ALL_PASSED_SLUG = "partitioned-all-passed";

export const TSPF_TC_010_ALL_PASSED_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TSPF_TC_010_ALL_PASSED_SLUG,
  cases: [
    {
      id: "TC-AP1",
      title: "All-passed spec: first passed case",
      area: "spec-picker",
      level: 1,
      type: "functional",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-002"],
      linked_user_story_ids: [],
      preconditions: ["The spec has an all-passed results sidecar"],
      steps: [
        {
          id: "TC-AP1-S1",
          instruction: "Perform the first check",
          observations: [{ id: "TC-AP1-S1-O1", expected: "It passes" }],
        },
      ],
    },
    {
      id: "TC-AP2",
      title: "All-passed spec: second passed case",
      area: "spec-picker",
      level: 1,
      type: "functional",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-002"],
      linked_user_story_ids: [],
      preconditions: ["The spec has an all-passed results sidecar"],
      steps: [
        {
          id: "TC-AP2-S1",
          instruction: "Perform the second check",
          observations: [{ id: "TC-AP2-S1-O1", expected: "It passes" }],
        },
      ],
    },
    {
      id: "TC-AP3",
      title: "All-passed spec: third passed case",
      area: "spec-picker",
      level: 1,
      type: "functional",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-002"],
      linked_user_story_ids: [],
      preconditions: ["The spec has an all-passed results sidecar"],
      steps: [
        {
          id: "TC-AP3-S1",
          instruction: "Perform the third check",
          observations: [{ id: "TC-AP3-S1-O1", expected: "It passes" }],
        },
      ],
    },
  ],
};

// The all-passed spec's discovered case count, so a row assertion derives "All N
// passed" from the seeded plan rather than hard-coding it.
export const TSPF_TC_010_ALL_PASSED_CASE_COUNT = TSPF_TC_010_ALL_PASSED_PLAN.cases.length;

// The slices that own each leg of the partitioned-picker journey, surfaced in a
// failing run so a divergence localises to an attributable slice from THIS unit's
// blocked-by set (FR-020 / the issue's AC7 failure-output contract).
export const TSPF_TC_010_OWNING_SLICES: Record<string, string> = {
  picker: "#483 (partitioned spec picker: modal opens from the empty-slot flow)",
  discovery: "#482 (discovery aggregation: per-spec verification + classification)",
  mainSpace: "#483/#484 (partitioned picker: needs-attention main space, no all-passed leak)",
  summary: "#482/#483 (discovery pass-state aggregate + per-row summary)",
  disclosure: "#483 (partitioned picker: collapsed all-passed disclosure)",
  expandedRows: "#483 (partitioned picker: expanded, de-emphasized all-passed rows)",
  selection: "#483 (partitioned picker: cross-group single selection)",
  createBinding: "#482/#483 (discovery classification + picker create binding)",
};

// ─────────────────────────────────────────────────────────────────────────────
// TSPF-TC-011 (#487): the authoritative `e2e_flow` case the "change an active
// TestBench's focused spec through the identical partitioned picker" journey
// drift-guards against. This is the schema-valid projection of TSPF-TC-011 in
// `.specifications/testbench-spec-picker-filter/test-cases.json`: opening the
// re-point picker on a project whose repo carries BOTH classifications, asserting
// it renders the IDENTICAL partition the create picker renders on the same repo
// state (needs-attention specs in the prominent main space, all-passed specs
// behind the same collapsed disclosure, identical per-row summaries), then
// re-pointing to a needs-attention spec and proving the previous spec's results
// survive (TSPF-FR-005, TSPF-US-003).
//
// Both pickers render the SAME SpecPickerModal off the SAME endpoint
// (`GET /:projectId/testbench/specs`), whose per-spec `verification.classification`
// drives the partition, so "identical" is asserted by driving both pickers on one
// project and comparing the rendered partition. Three plans are seeded into one
// fixture repo so both partition groups are populated:
//   - TSPF_ACTIVE_PLAN (picker-active-spec): the create-bound spec. No results
//     sidecar is seeded in the PROJECT repo, so discovery classifies it
//     needs-attention with a "no results yet" summary. The test records a result
//     against it in the bench WORKTREE (not the project repo), so the picker's
//     project-repo partition is unaffected and stays identical across both flows.
//   - TSPF_ATTENTION_PLAN (picker-attention-spec): seeded with a PARTIAL all-pass
//     (one of three cases passed), so discovery classifies it needs-attention with
//     a "1 of 3 passed" summary. It is the re-point target.
//   - TSPF_PASSED_PLAN (picker-passed-spec): seeded with a FULL all-pass (every
//     case passed), so discovery classifies it all-passed with an "All 2 passed"
//     summary and relegates it behind the collapsed disclosure.
// ─────────────────────────────────────────────────────────────────────────────
export const TSPF_ACTIVE_SPEC_SLUG = "picker-active-spec";
export const TSPF_ATTENTION_SPEC_SLUG = "picker-attention-spec";
export const TSPF_PASSED_SPEC_SLUG = "picker-passed-spec";

export const TSPF_ACTIVE_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TSPF_ACTIVE_SPEC_SLUG,
  cases: [
    {
      id: "TSPF-ACT-01",
      title: "Active spec: the case a result is recorded against before the re-point",
      area: "spec-picker",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-005"],
      linked_user_story_ids: ["TSPF-US-003"],
      preconditions: ["A TestBench is bound to the active spec"],
      steps: [
        {
          id: "TSPF-ACT-01-S1",
          instruction: "Perform the active-spec check",
          observations: [
            { id: "TSPF-ACT-01-S1-O1", expected: "The active spec behaves as specified" },
          ],
        },
      ],
    },
  ],
};

export const TSPF_ATTENTION_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TSPF_ATTENTION_SPEC_SLUG,
  cases: [
    {
      id: "TSPF-ATT-01",
      title: "Attention spec: the one case seeded passed (1 of 3)",
      area: "spec-picker",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-005"],
      linked_user_story_ids: ["TSPF-US-003"],
      preconditions: ["The attention spec is discoverable in the project repo"],
      steps: [
        {
          id: "TSPF-ATT-01-S1",
          instruction: "Perform the first attention check",
          observations: [{ id: "TSPF-ATT-01-S1-O1", expected: "The first check passes" }],
        },
      ],
    },
    {
      id: "TSPF-ATT-02",
      title: "Attention spec: a case left needing attention",
      area: "spec-picker",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-005"],
      linked_user_story_ids: ["TSPF-US-003"],
      preconditions: ["The attention spec is discoverable in the project repo"],
      steps: [
        {
          id: "TSPF-ATT-02-S1",
          instruction: "Perform the second attention check",
          observations: [{ id: "TSPF-ATT-02-S1-O1", expected: "The second check passes" }],
        },
      ],
    },
    {
      id: "TSPF-ATT-03",
      title: "Attention spec: another case left needing attention",
      area: "spec-picker",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-005"],
      linked_user_story_ids: ["TSPF-US-003"],
      preconditions: ["The attention spec is discoverable in the project repo"],
      steps: [
        {
          id: "TSPF-ATT-03-S1",
          instruction: "Perform the third attention check",
          observations: [{ id: "TSPF-ATT-03-S1-O1", expected: "The third check passes" }],
        },
      ],
    },
  ],
};

export const TSPF_PASSED_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: TSPF_PASSED_SPEC_SLUG,
  cases: [
    {
      id: "TSPF-PASS-01",
      title: "Passed spec: first case, seeded passed",
      area: "spec-picker",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-005"],
      linked_user_story_ids: ["TSPF-US-003"],
      preconditions: ["The passed spec is discoverable in the project repo"],
      steps: [
        {
          id: "TSPF-PASS-01-S1",
          instruction: "Perform the first passed check",
          observations: [{ id: "TSPF-PASS-01-S1-O1", expected: "The first check passes" }],
        },
      ],
    },
    {
      id: "TSPF-PASS-02",
      title: "Passed spec: second case, seeded passed",
      area: "spec-picker",
      level: 1,
      type: "e2e_flow",
      priority: "P0",
      tags: [],
      linked_requirement_ids: ["TSPF-FR-005"],
      linked_user_story_ids: ["TSPF-US-003"],
      preconditions: ["The passed spec is discoverable in the project repo"],
      steps: [
        {
          id: "TSPF-PASS-02-S1",
          instruction: "Perform the second passed check",
          observations: [{ id: "TSPF-PASS-02-S1-O1", expected: "The second check passes" }],
        },
      ],
    },
  ],
};

// The slices that own each leg of the TSPF-TC-011 journey, surfaced in a failing
// run so a divergence localises to an attributable slice (AC5, the failure-output
// contract). This work unit's `blocked_by` set is exactly {#483}: the partitioned
// spec-picker slice that both the create and re-point pickers render off. The
// journey-proper steps (opening the shared picker, the partition + its identity
// across both flows, the results-preserving re-point) therefore all name #483; the
// enable / create / review scaffolding steps name their own setup slices, which
// are preconditions rather than part of the drift-guarded partition journey.
export const OWNING_SLICES_TSPF_TC011: Record<string, string> = {
  // Preconditions (shared scaffolding, not the TSPF-TC-011 journey proper).
  enable: "#414 (TestBench settings toggle)",
  createBinding: "#416/#418 (create-a-TestBench flow: spec-bound worktree)",
  reviewPanel: "#416 (bench-variant create: TestBench tab surface + results panel)",
  // The TSPF-TC-011 journey proper (blocked by #483, the sole blocked-by).
  repointAction: "#483 (partitioned spec picker: 'Change focused spec' opens the shared picker)",
  partition:
    "#483 (partitioned spec picker: needs-attention main space + all-passed disclosure + per-row summaries)",
  identicalPartition:
    "#483 (partitioned spec picker: create and re-point render the identical partition)",
  repointConfirm:
    "#483 (partitioned spec picker: re-point confirm re-points and preserves the previous spec's results)",
};

// ─────────────────────────────────────────────────────────────────────────────
// SATCA-TC-035/036/037/038 (#770): the fixture set for the "hide archived specs
// by default, reveal them on demand" picker journey. Three specs are seeded into
// one fixture repo so the default list, the reveal control, and both archived
// labels are all exercised:
//   - SATCA_LIVE_SPEC_SLUG: no manifest at all, so the lifecycle reader sees no
//     record and the spec is live (SATCA-FR-017). It is what stays listed by
//     default.
//   - SATCA_ARCHIVED_SPEC_SLUG: an `{ archived: true, reason }` record, so it is
//     hidden by default and labelled "Archived" once revealed.
//   - SATCA_SUPERSEDED_SPEC_SLUG: an `{ archived: true, supersededBy }` record.
//     Superseded is DERIVED from the pointer, not persisted as its own state, so
//     this spec proves the picker labels it distinctly and names its replacement.
// ─────────────────────────────────────────────────────────────────────────────
export const SATCA_LIVE_SPEC_SLUG = "archival-live-spec";
export const SATCA_ARCHIVED_SPEC_SLUG = "archival-archived-spec";
export const SATCA_SUPERSEDED_SPEC_SLUG = "archival-superseded-spec";

// The reason recorded on the merely-archived spec, asserted verbatim in the
// revealed row so the label is proven to come from the record on disk.
export const SATCA_ARCHIVED_REASON = "Shipped in #212";

// A one-case plan per spec: the journey is about the lifecycle partition, not the
// case list, so the plans stay minimal and differ only by slug.
function archivalPlan(slug: string, caseId: string): TestCasesPlan {
  return {
    $schema: TEST_CASES_SCHEMA_ID,
    schemaVersion: TEST_CASES_SCHEMA_VERSION,
    specSlug: slug,
    cases: [
      {
        id: caseId,
        title: `Archival fixture case for ${slug}`,
        area: "spec-archival",
        level: 1,
        type: "functional",
        priority: "P0",
        tags: [],
        linked_requirement_ids: ["SATCA-FR-016"],
        linked_user_story_ids: [],
        steps: [
          {
            id: `${caseId}-S1`,
            instruction: "Perform the check",
            observations: [{ id: `${caseId}-S1-O1`, expected: "It holds" }],
          },
        ],
      },
    ],
  };
}

export const SATCA_LIVE_PLAN: TestCasesPlan = archivalPlan(SATCA_LIVE_SPEC_SLUG, "SATCA-LIVE-01");
export const SATCA_ARCHIVED_PLAN: TestCasesPlan = archivalPlan(
  SATCA_ARCHIVED_SPEC_SLUG,
  "SATCA-ARCH-01",
);
export const SATCA_SUPERSEDED_PLAN: TestCasesPlan = archivalPlan(
  SATCA_SUPERSEDED_SPEC_SLUG,
  "SATCA-SUPER-01",
);

// ─────────────────────────────────────────────────────────────────────────────
// #773 (SATCA-TC-047/048/049/050): the spec lifecycle WRITE journey. Three live
// specs, differing only in what manifest they start with, so one journey covers
// every write shape:
//   - SATCA_LIVE_SPEC_SLUG (reused above): no manifest at all, so archiving it
//     exercises minimal-manifest creation (TC-048).
//   - SATCA_RICH_SPEC_SLUG: a realistic product-dev manifest carrying stage
//     tracking, id counters, and a key Roubo has never heard of, so archiving it
//     proves the merge-write preserves everything it did not author (TC-049) and
//     leaves the case file byte-identical (TC-047).
//   - SATCA_SUPERSEDED_SPEC_SLUG (reused above): the spec superseded and then
//     restored, proving the pointer is reversible (TC-050 S004).
// ─────────────────────────────────────────────────────────────────────────────
export const SATCA_RICH_SPEC_SLUG = "archival-rich-spec";

export const SATCA_RICH_PLAN: TestCasesPlan = archivalPlan(SATCA_RICH_SPEC_SLUG, "SATCA-RICH-01");

// The unrecognised key the merge-write has to carry through verbatim, and the
// manifest it sits in. Shaped like a real `.specifications/<slug>/manifest.json`
// (snake_case keys, ISO-Z timestamps), because the point of the assertion is
// that Roubo is a second writer of a file it does not own.
export const SATCA_UNRECOGNISED_MANIFEST_KEY = "a_key_roubo_has_never_heard_of";

export const SATCA_RICH_MANIFEST: Record<string, unknown> = {
  schema_version: 1,
  slug: SATCA_RICH_SPEC_SLUG,
  title: "Archival rich fixture",
  created_at: "2026-08-06T01:07:49Z",
  updated_at: "2026-08-06T10:33:17Z",
  current_stage: "align",
  stages: {
    interview: { status: "done", artifact: "brief.md", updated_at: "2026-08-06T01:07:49Z" },
    prd: { status: "done", artifact: "prd.md", updated_at: "2026-08-06T03:11:02Z" },
  },
  id_counters: { FR: 30, NFR: 8, US: 12, TC: 50 },
  spikes: [{ issue: 781, status: "resolved" }],
  id_code: "SATCA",
  design_root: "roubo",
  [SATCA_UNRECOGNISED_MANIFEST_KEY]: { nested: ["values", 42], keep: true },
};

// The reason the reviewer types into the Archive confirm step, asserted back out
// of the manifest on disk.
export const SATCA_WRITE_REASON = "Shipped in #212, all issues closed";

// The slices that own each leg of the archival WRITE journey.
export const SATCA_WRITE_OWNING_SLICES: Record<string, string> = {
  archive: "#773 (spec lifecycle write: archive from the picker)",
  minimal: "#773 (spec lifecycle write: minimal manifest creation)",
  preserve: "#773 (spec lifecycle write: merge-write key preservation)",
  supersede: "#773 (spec lifecycle write: supersede from the project's other specs)",
  reverse: "#773 (spec lifecycle write: reversal from the same surface)",
};

// The slices that own each leg of the archival-picker journey, surfaced in a
// failing run so a divergence localises to an attributable slice.
export const SATCA_PICKER_OWNING_SLICES: Record<string, string> = {
  discovery: "#765 (spec lifecycle reader + per-spec lifecycle on discovery)",
  hidden: "#770 (spec picker: archived specs hidden from the default list)",
  reveal: "#770 (spec picker: the show-archived reveal control)",
  labels: "#770 (spec picker: archived vs superseded row labels)",
  selectable: "#770 (spec picker: a revealed archived spec stays selectable)",
  panel: "#770 (TestBench panel: archived indicator for the focused spec)",
};

// ─────────────────────────────────────────────────────────────────────────────
// SATCA-TC-010 (#776): the CASE lifecycle FORMAT journey. The precondition the
// case states is "a spec whose cases are all live", so the fixture plan seeds
// three live cases and the journey applies the lifecycle blocks itself, by hand,
// into the bench's own worktree. That ordering is the point: it proves the
// running app reads a file-authored retirement off disk (SATCA-FR-001/FR-002),
// rather than merely rendering a plan that arrived pre-retired.
//
//   - SATCA_TC010_RETIRE_CASE_ID: gains a `retired` block with a reason (S001).
//   - SATCA_TC010_SUPERSEDE_CASE_ID: gains a `superseded` block whose bare
//     pointer names the third case (S002), which stays live so the pointer
//     resolves same-spec and present.
//   - SATCA_TC010_REPLACEMENT_CASE_ID: never edited. It is both the replacement
//     and the proof that live cases stay in the live list.
// ─────────────────────────────────────────────────────────────────────────────
export const SATCA_TC010_SPEC_SLUG = "archival-case-lifecycle-spec";

export const SATCA_TC010_RETIRE_CASE_ID = "SATCA-CLF-01";
export const SATCA_TC010_SUPERSEDE_CASE_ID = "SATCA-CLF-02";
export const SATCA_TC010_REPLACEMENT_CASE_ID = "SATCA-CLF-03";

// The reason hand-authored into the retired block, asserted VERBATIM out of the
// archived entry (S003-O03). Deliberately a full sentence with punctuation, so a
// truncating or re-worded render fails rather than passes on a prefix match.
export const SATCA_TC010_RETIRED_REASON =
  "The manual upload path was removed in #212, so this case can never run again.";

// The reason carried alongside the supersession, which the contract allows on a
// `superseded` block. It keeps the two archived entries distinguishable in the
// panel by their text as well as by their state label.
export const SATCA_TC010_SUPERSEDED_REASON = "Replaced by the batch-import case.";

function caseLifecycleCase(id: string, title: string): TestCasesPlan["cases"][number] {
  return {
    id,
    title,
    area: "case-lifecycle-format",
    level: 1,
    type: "functional",
    priority: "P0",
    tags: [],
    linked_requirement_ids: ["SATCA-FR-001"],
    linked_user_story_ids: ["SATCA-US-001"],
    steps: [
      {
        id: `${id}-S1`,
        instruction: "Perform the check",
        observations: [{ id: `${id}-S1-O1`, expected: "It holds" }],
      },
    ],
  };
}

// The precondition plan: three cases, every one of them live (no `lifecycle` key
// anywhere, which is what "live" means at v1.2.0).
export const SATCA_TC010_LIVE_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: SATCA_TC010_SPEC_SLUG,
  cases: [
    caseLifecycleCase(SATCA_TC010_RETIRE_CASE_ID, "Upload a report by hand"),
    caseLifecycleCase(SATCA_TC010_SUPERSEDE_CASE_ID, "Import a report one file at a time"),
    caseLifecycleCase(SATCA_TC010_REPLACEMENT_CASE_ID, "Import a batch of reports"),
  ],
};

// The same plan after the hand edits of S001 and S002: one case retired with a
// reason, one superseded with a bare same-spec pointer at the third. Built from
// the live plan so the two can never drift apart, and so the only difference the
// app can be reading is the lifecycle block itself.
export const SATCA_TC010_EDITED_PLAN: TestCasesPlan = {
  ...SATCA_TC010_LIVE_PLAN,
  cases: SATCA_TC010_LIVE_PLAN.cases.map((c) => {
    if (c.id === SATCA_TC010_RETIRE_CASE_ID) {
      return { ...c, lifecycle: { state: "retired", reason: SATCA_TC010_RETIRED_REASON } as const };
    }
    if (c.id === SATCA_TC010_SUPERSEDE_CASE_ID) {
      return {
        ...c,
        lifecycle: {
          state: "superseded",
          replacement: SATCA_TC010_REPLACEMENT_CASE_ID,
          reason: SATCA_TC010_SUPERSEDED_REASON,
        } as const,
      };
    }
    return c;
  }),
};

// The slices that own each leg of the case lifecycle format journey, surfaced in
// every assertion message so a failing integrated run attributes the divergence
// to a slice rather than to "the journey". Drawn from #776's blocked-by set,
// minus the legs SATCA-TC-010 has no step for (#774's replacement picker and
// #768/#781's verify gate are proven by their own journeys), plus the two
// preconditions the journey needs before any lifecycle block exists.
export const SATCA_TC010_OWNING_SLICES: Record<string, string> = {
  enable: "#416 (TestBench feature flag: the panel is reachable at all)",
  create: "#438 (create a TestBench from an empty slot: spec-bound worktree)",
  live: "#769 (rollup and panel: a case with no lifecycle block is live)",
  contract: "#764 (case lifecycle block in the case contract, at schema v1.2.0)",
  excluded: "#769 (rollup and panel: exclude non-live cases from the live list)",
  archived: "#769 (rollup and panel: show non-live cases as archived, labelled)",
  reason: "#769 (rollup and panel: the recorded reason is shown verbatim)",
  replacement:
    "#766/#763 (LifecycleResolver + pointer resolution rules: same-spec pointer, live predicate)",
};

// ─────────────────────────────────────────────────────────────────────────────
// #775 (SATCA-TC-019/044/057/078, SATCA-NFR-005): the archival accessibility
// pass needs a spec whose PLAN already carries case-level lifecycle records, so
// the panel's Archived section renders with both of its lifecycle shapes without
// any in-app write first. One live case keeps the live list (and the case detail
// pane, and its lifecycle disclosures) reachable; the retired case exercises the
// reason text; the superseded case points at the live one, which is what makes
// its "Replaced by" reveal an activatable control rather than inert text (#789).
//
// #797 adds a FOURTH case, live and unmarked in the plan, that the contrast spec
// marks and then retires in-app. The pass/fail mark colours in the Archived
// section's ObservationMarks are unreachable from the fixture seam (the seeded
// results synthesizer writes an empty `observationMarks` map for every case, and
// ObservationMarks renders nothing for an empty map), so the only way to put
// mark text on an archived entry is the real mark-then-retire journey. It needs
// its own case because retiring SATCA_A11Y_LIVE_CASE_ID would remove the live
// case the later retire/supersede disclosure steps depend on, and it needs TWO
// observations because one archived entry has to carry both the green (pass) and
// the red (fail) token for a single scan to measure both. The two expectations
// differ because the mark control's accessible name is
// `Mark observation pass or fail: ${expected}`, so identical texts would make
// the two radiogroups indistinguishable to the test.
// ─────────────────────────────────────────────────────────────────────────────
export const SATCA_A11Y_SPEC_SLUG = "archival-a11y-spec";
export const SATCA_A11Y_LIVE_CASE_ID = "SATCA-A11Y-01";
export const SATCA_A11Y_RETIRED_CASE_ID = "SATCA-A11Y-02";
export const SATCA_A11Y_SUPERSEDED_CASE_ID = "SATCA-A11Y-03";
export const SATCA_A11Y_MARKED_CASE_ID = "SATCA-A11Y-04";
export const SATCA_A11Y_RETIRED_REASON = "Folded into the batch-level smoke check";

// The two distinct observation expectations on the marked case, used verbatim to
// address each observation's mark control by its accessible name.
export const SATCA_A11Y_MARK_PASS_EXPECTATION = "The recorded green mark survives archival";
export const SATCA_A11Y_MARK_FAIL_EXPECTATION = "The recorded red mark survives archival";

// The reason typed into the retire disclosure for the marked case. Deliberately
// free of the words the mark text uses, so an assertion on the retained mark
// text cannot pass on the reason instead.
export const SATCA_A11Y_MARKED_REASON = "Retired once both observations were marked";

function a11yCase(
  id: string,
  lifecycle?: CaseLifecycle,
  expectations: readonly string[] = ["It holds"],
): TestCasesPlan["cases"][number] {
  return {
    id,
    title: `Archival accessibility fixture case ${id}`,
    area: "spec-archival",
    level: 1,
    type: "accessibility",
    priority: "P0",
    tags: [],
    linked_requirement_ids: ["SATCA-NFR-005"],
    linked_user_story_ids: [],
    steps: [
      {
        id: `${id}-S1`,
        instruction: "Perform the check",
        observations: expectations.map((expected, index) => ({
          id: `${id}-S1-O${index + 1}`,
          expected,
        })),
      },
    ],
    ...(lifecycle === undefined ? {} : { lifecycle }),
  };
}

export const SATCA_A11Y_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: SATCA_A11Y_SPEC_SLUG,
  cases: [
    a11yCase(SATCA_A11Y_LIVE_CASE_ID),
    a11yCase(SATCA_A11Y_RETIRED_CASE_ID, {
      state: "retired",
      reason: SATCA_A11Y_RETIRED_REASON,
    }),
    a11yCase(SATCA_A11Y_SUPERSEDED_CASE_ID, {
      state: "superseded",
      replacement: SATCA_A11Y_LIVE_CASE_ID,
    }),
    a11yCase(SATCA_A11Y_MARKED_CASE_ID, undefined, [
      SATCA_A11Y_MARK_PASS_EXPECTATION,
      SATCA_A11Y_MARK_FAIL_EXPECTATION,
    ]),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// SATCA-TC-020 (#777): the rollup-and-panel RETIREMENT journey. The precondition
// the case states is "a spec open in a bench with at least three live cases", so
// the fixture seeds exactly three, and the journey records a result against each
// one before it retires anything. That ordering is what makes S003-O02 provable:
// "the rollup denominator and passed count BOTH drop by the case's contribution"
// only means something when the retired case was itself contributing a pass.
//
//   - SATCA_TC020_RETIRE_CASE_ID: marked PASSED, then retired. Its contribution
//     is one pass out of a total of three, so the Overall readout must fall from
//     2 passed of 3 to 1 passed of 2.
//   - SATCA_TC020_PASSED_CASE_ID: marked passed and never touched again. It is
//     the proof that the untouched half of the rollup is unmoved.
//   - SATCA_TC020_FAILED_CASE_ID: marked FAILED, so the denominator drop cannot
//     be mistaken for "everything passed" arithmetic: the failed count has to
//     stay at one across the retire and the restore.
//
// Unlike SATCA-TC-010 (#776), which authors the lifecycle block BY HAND in the
// case file, this journey drives the IN-APP retire control (S002 says "start the
// retire action", and the reason-required / empty-refused observation exists only
// on that control), then reverses it from the archived entry.
// ─────────────────────────────────────────────────────────────────────────────
export const SATCA_TC020_SPEC_SLUG = "archival-rollup-panel-spec";

export const SATCA_TC020_RETIRE_CASE_ID = "SATCA-RPJ-01";
export const SATCA_TC020_PASSED_CASE_ID = "SATCA-RPJ-02";
export const SATCA_TC020_FAILED_CASE_ID = "SATCA-RPJ-03";

// The reason typed into the in-app retire panel, asserted VERBATIM out of the
// archived entry (S003-O03). A full sentence with punctuation, so a truncating or
// re-worded render fails rather than passing on a prefix match.
export const SATCA_TC020_RETIRE_REASON =
  "The hand-upload surface was removed in #212, so this case can never be run again.";

function rollupJourneyCase(id: string, title: string): TestCasesPlan["cases"][number] {
  return {
    id,
    title,
    area: "rollup-and-panel",
    level: 1,
    type: "functional",
    priority: "P0",
    tags: [],
    linked_requirement_ids: ["SATCA-FR-005"],
    linked_user_story_ids: ["SATCA-US-003"],
    steps: [
      {
        id: `${id}-S1`,
        instruction: "Perform the check",
        observations: [{ id: `${id}-S1-O1`, expected: "It holds" }],
      },
    ],
  };
}

// The precondition plan: three cases, every one of them live (no `lifecycle` key
// anywhere, which is what "live" means at v1.2.0).
export const SATCA_TC020_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: SATCA_TC020_SPEC_SLUG,
  cases: [
    rollupJourneyCase(SATCA_TC020_RETIRE_CASE_ID, "Upload a report by hand"),
    rollupJourneyCase(SATCA_TC020_PASSED_CASE_ID, "Import a batch of reports"),
    rollupJourneyCase(SATCA_TC020_FAILED_CASE_ID, "Export a report to CSV"),
  ],
};

// The Overall rollup is a `role="img"` whose aria-label carries the whole readout
// (ProgressBar), so the denominator assertion needs no new test id. Building the
// expected label here rather than in the spec keeps the three snapshots (before
// the retire, after it, after the restore) in one shape.
export function satcaTc020OverallLabel(counts: {
  passed: number;
  failed: number;
  total: number;
}): string {
  const remaining = counts.total - counts.passed - counts.failed;
  return `Overall: ${counts.passed} passed, ${counts.failed} failed, 0 in progress, ${remaining} remaining of ${counts.total}`;
}

// The slices that own each leg of the rollup-and-panel retirement journey,
// surfaced in every assertion message so a failing integrated run attributes the
// divergence to a slice rather than to "the journey". Drawn from #777's
// blocked-by set (#766, #768, #769, #770, #774, #775, #781), minus the legs
// SATCA-TC-020 has no step for (#768/#781's verify gate is SATCA-TC-033's half of
// this unit, and #774's replacement picker belongs to supersede, not retire),
// plus the scaffolding preconditions the journey needs before any case is live on
// screen and the write slice the in-app retire action itself lives in (#772,
// which S002's "start the retire action" reaches and which no blocked-by entry
// covers).
export const SATCA_TC020_OWNING_SLICES: Record<string, string> = {
  enable: "#416 (TestBench feature flag: the panel is reachable at all)",
  create: "#438 (create a TestBench from an empty slot: spec-bound worktree)",
  live: "#769 (rollup and panel: a case with no lifecycle block is live)",
  marks: "#412/#415 (mark observations + sidecar persist)",
  rollup: "#769 (rollup and panel: the Overall rollup counts live cases only)",
  retireControl: "#772 (case lifecycle write path: the in-app retire action)",
  reasonRequired: "#772 (case lifecycle write path: retire refuses an empty reason)",
  excluded: "#769 (rollup and panel: exclude non-live cases from the live list)",
  archived: "#769 (rollup and panel: show non-live cases as archived, labelled)",
  reason: "#769 (rollup and panel: the recorded reason is shown verbatim)",
  restore: "#772 (case lifecycle write path: restore clears the lifecycle record)",
  resolver: "#766 (LifecycleResolver: the live predicate the rollup partitions on)",
  panel: "#775 (accessibility pass: focus lands on the archived entry after the write)",
};

// ─────────────────────────────────────────────────────────────────────────────
// SATCA-TC-033 (#777): the verify-gate RELEASE journey. The precondition is "a
// gate reporting pending, held only by one case that has never been started", so
// the fixture declares a gate over exactly two L1 cases:
//
//   - SATCA_TC033_PASSED_CASE_ID: marked passed in-app before the gate is opened,
//     so it is not what holds the gate.
//   - SATCA_TC033_BLOCKING_CASE_ID: never started, so it is the sole reason the
//     gate reads pending, and the case S001-O01 requires the gate to NAME.
//
// The gate must declare a second, already-passed case rather than only the case
// being retired. Retiring the only declared case would empty the gating set, and
// an empty set is deliberately NOT a pass (`no_gating_cases`, #436, VG-NFR-007);
// the case says the gate "reports passed", so the fixture is shaped to reach the
// passed rung rather than the structural-empty one.
//
// S003-O03 ("no work unit file was edited") is the reason the fixture seeds a
// real `work-units.json`: the gate narrows its set at READ time from the case
// lifecycle, and never writes back the declared `implements.test_case_ids`. The
// spec proves that against the file's own bytes.
// ─────────────────────────────────────────────────────────────────────────────
export const SATCA_TC033_SPEC_SLUG = "archival-gate-release-spec";

export const SATCA_TC033_PASSED_CASE_ID = "SATCA-GRJ-01";
export const SATCA_TC033_BLOCKING_CASE_ID = "SATCA-GRJ-02";

// The verify unit's id IS the gate id, and its milestone is what titles the card
// on the Batches overview (issue #433).
export const SATCA_TC033_GATE_ID = "GRJ-WU-002";
export const SATCA_TC033_GATE_MILESTONE = "Archival gate release";
export const SATCA_TC033_COVERED_UNIT_ID = "GRJ-WU-001";

// The reason typed into the retire panel for the blocking case (S002).
export const SATCA_TC033_RETIRE_REASON =
  "The blocking scenario was dropped from the release, so this case will never be run.";

function gateJourneyCase(id: string, title: string): TestCasesPlan["cases"][number] {
  return {
    id,
    title,
    area: "verify-gate",
    level: 1,
    type: "functional",
    priority: "P0",
    tags: [],
    linked_requirement_ids: ["SATCA-FR-008"],
    linked_user_story_ids: ["SATCA-US-003"],
    steps: [
      {
        id: `${id}-S1`,
        instruction: "Perform the check",
        observations: [{ id: `${id}-S1-O1`, expected: "It holds" }],
      },
    ],
  };
}

export const SATCA_TC033_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: SATCA_TC033_SPEC_SLUG,
  cases: [
    gateJourneyCase(SATCA_TC033_PASSED_CASE_ID, "The scenario that is verified before the gate"),
    gateJourneyCase(SATCA_TC033_BLOCKING_CASE_ID, "The scenario that has never been started"),
  ],
};

// The spec's `work-units.json`: one delivery slice plus the verify gate that
// spans it. Both L1 cases sit in the gate's `implements.test_case_ids`, which IS
// the declared gating set, and the file is asserted byte-identical across the
// whole journey (S003-O03).
export const SATCA_TC033_WORK_UNITS: WorkUnitsFile = {
  $schema: WORK_UNITS_SCHEMA_ID,
  schemaVersion: WORK_UNITS_SCHEMA_VERSION,
  specSlug: SATCA_TC033_SPEC_SLUG,
  units: [
    {
      id: SATCA_TC033_COVERED_UNIT_ID,
      title: "Deliver the archival gate-release scenarios",
      type: "feature",
      description: "The delivery slice the verify gate spans.",
      acceptance_criteria: ["Both scenarios are implemented."],
      depends_on: [],
      implements: {
        requirement_ids: ["SATCA-FR-008"],
        user_story_ids: ["SATCA-US-003"],
        test_case_ids: [SATCA_TC033_PASSED_CASE_ID, SATCA_TC033_BLOCKING_CASE_ID],
      },
    },
    {
      id: SATCA_TC033_GATE_ID,
      title: "Verify: archival gate release",
      type: "task",
      kind: "verify",
      milestone: SATCA_TC033_GATE_MILESTONE,
      description: "The verify gate over the archival gate-release scenarios.",
      acceptance_criteria: ["Every gating case is verified."],
      depends_on: [SATCA_TC033_COVERED_UNIT_ID],
      covers: [SATCA_TC033_COVERED_UNIT_ID],
      implements: {
        requirement_ids: ["SATCA-FR-008"],
        user_story_ids: ["SATCA-US-003"],
        test_case_ids: [SATCA_TC033_PASSED_CASE_ID, SATCA_TC033_BLOCKING_CASE_ID],
      },
    },
  ],
};

// The slices that own each leg of the gate-release journey, drawn from #777's
// blocked-by set. #768 owns the evaluator's lifecycle narrowing and #781 the
// Phase 2 gate surfaces the journey reads it through; #772 owns the in-app retire
// write S002 drives, which no blocked-by entry covers; the enable / create legs
// are scaffolding preconditions rather than part of the drift-guarded journey.
export const SATCA_TC033_OWNING_SLICES: Record<string, string> = {
  enable: "#416 (TestBench feature flag: the panel is reachable at all)",
  create: "#438 (create a TestBench from an empty slot: spec-bound worktree)",
  marks: "#412/#415 (mark observations + sidecar persist)",
  batches: "#781 (verify gate Phase 2 surfaces: the Batches overview lists the gate)",
  gateView: "#781 (verify gate Phase 2 surfaces: the gate view and its state panel)",
  pending: "#768 (verify gate: an unstarted gating case holds the gate pending)",
  namesCase: "#781 (verify gate Phase 2 surfaces: the gate names its unresolved cases)",
  retireControl: "#772 (case lifecycle write path: the in-app retire action)",
  released: "#768 (verify gate: a retired case leaves the effective gating set)",
  excludedStated: "#768/#781 (verify gate: the gate view states the lifecycle exclusion)",
  resolver: "#766 (LifecycleResolver: the live predicate the gate narrows on)",
  workUnitsUntouched: "#768 (verify gate: narrowing is computed at read time, never written back)",
};

// ─────────────────────────────────────────────────────────────────────────────
// SATCA-TC-058 (#779): the IN-APP ACTIONS journey. Where SATCA-TC-010 (#776)
// proves a HAND-AUTHORED retirement is read by the app, this one proves the
// reverse direction: an in-app retirement is WRITTEN, is reviewable as an
// ordinary uncommitted git change, and reverses cleanly.
//
// The precondition the case states is "a clean working tree with a spec open in
// a bench", so the plan seeds three live cases (no lifecycle key anywhere) and
// the journey applies the record itself, through the real panel controls, into
// the bench's own worktree.
//
//   - SATCA_TC058_RETIRE_CASE_ID: retired from the panel with a reason (S001).
//   - the other two are never touched. They are the positive control that the
//     live list has rendered (so the retired case's absence is meaningful), and
//     the proof that the diff reaches exactly one case body and no sibling.
//
// `steps` is deliberately the LAST key on a case object: the writer appends
// `lifecycle` after the existing keys, so the diff the journey asserts on is the
// closing `]` of `steps` gaining a comma plus the lifecycle record's own lines,
// and nothing else.
// ─────────────────────────────────────────────────────────────────────────────
export const SATCA_TC058_SPEC_SLUG = "archival-in-app-actions-spec";

export const SATCA_TC058_RETIRE_CASE_ID = "SATCA-IAA-01";
export const SATCA_TC058_UNTOUCHED_CASE_IDS = ["SATCA-IAA-02", "SATCA-IAA-03"] as const;

// The reason typed into the retire disclosure. A full sentence with punctuation,
// so a truncating render or a re-worded record fails rather than passing on a
// prefix match, and free of characters JSON would escape, so the expected diff
// line stays readable beside the assertion that uses it.
export const SATCA_TC058_REASON =
  "The manual worksheet this case covers was withdrawn, so it can never run again.";

function inAppActionsCase(id: string, title: string): TestCasesPlan["cases"][number] {
  return {
    id,
    title,
    area: "in-app-actions",
    level: 1,
    type: "functional",
    priority: "P0",
    tags: [],
    linked_requirement_ids: ["SATCA-FR-019"],
    linked_user_story_ids: ["SATCA-US-006"],
    steps: [
      {
        id: `${id}-S1`,
        instruction: "Perform the check",
        observations: [{ id: `${id}-S1-O1`, expected: "It holds" }],
      },
    ],
  };
}

// The precondition plan: three cases, every one of them live. Seeded before the
// fixture repo's initial commit, so the bench worktree starts clean and the
// journey's git assertions have a real baseline.
export const SATCA_TC058_LIVE_PLAN: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: TEST_CASES_SCHEMA_VERSION,
  specSlug: SATCA_TC058_SPEC_SLUG,
  cases: [
    inAppActionsCase(SATCA_TC058_RETIRE_CASE_ID, "Fill in the retirement worksheet by hand"),
    inAppActionsCase(SATCA_TC058_UNTOUCHED_CASE_IDS[0], "Import a worksheet one row at a time"),
    inAppActionsCase(SATCA_TC058_UNTOUCHED_CASE_IDS[1], "Import a batch of worksheets"),
  ],
};

// The path, relative to the bench worktree root, that the retirement is allowed
// to modify. S002-O01 asserts `modified` is exactly this one file.
export const SATCA_TC058_CASE_FILE_PATH = `.specifications/${SATCA_TC058_SPEC_SLUG}/test-cases.json`;

// The exact `+` lines the retirement is allowed to add to the case file, in
// order, at the indentation `JSON.stringify(document, null, 2)` produces for a
// key on a case object (6 spaces) and its nested fields (8). The first is the
// closing `]` of the edited case's `steps`, which gains a comma because
// `lifecycle` is appended after it; the rest are the lifecycle record itself.
// Asserting the literal lines is what makes S002-O02 ("the diff shows only the
// added lifecycle record") a real check rather than a substring sniff: any
// reflow, re-order, or collateral edit to another case fails it.
export const SATCA_TC058_EXPECTED_ADDED_LINES = [
  "      ],",
  '      "lifecycle": {',
  '        "state": "retired",',
  `        "reason": ${JSON.stringify(SATCA_TC058_REASON)}`,
  "      }",
];

// The only `-` line the retirement is allowed to remove: the same `]` without
// its new comma. A pure punctuation change, so no authored content is lost.
export const SATCA_TC058_EXPECTED_REMOVED_LINES = ["      ]"];

// The slices that own each leg of the in-app actions journey, surfaced in every
// assertion message so a failing integrated run attributes the divergence to a
// slice rather than to "the journey". Drawn from #779's blocked-by set (#767,
// #772, #773, #774, #775, #781), minus the legs SATCA-TC-058 has no step for
// (#773's spec-level write and #774's replacement picker are proven by their own
// journeys), plus the two preconditions the journey needs before it can act.
export const SATCA_TC058_OWNING_SLICES: Record<string, string> = {
  enable: "#416 (TestBench feature flag: the panel is reachable at all)",
  create: "#438 (create a TestBench from an empty slot: spec-bound worktree)",
  clean: "#438 (create a TestBench from an empty slot: the worktree starts clean)",
  live: "#769 (rollup and panel: a case with no lifecycle block is live)",
  controls: "#775 (archival accessibility: the retire disclosure and its controls)",
  write: "#772 (case lifecycle write: retire from the panel, with a reason)",
  panel: "#769 (rollup and panel: the panel updates immediately after the write)",
  scope: "#772 (case lifecycle write: one file, no sibling key rewritten)",
  diff: "#767 (canonicalization excludes the lifecycle block, so the diff is lifecycle-only)",
  uncommitted: "#772 (case lifecycle write: nothing is staged and nothing is committed)",
  restore: "#772 (case lifecycle write: restore clears the record, returning the tree to clean)",
};
