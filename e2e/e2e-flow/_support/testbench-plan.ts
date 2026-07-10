import {
  TEST_CASES_SCHEMA_ID,
  TEST_CASES_SCHEMA_VERSION,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";

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
