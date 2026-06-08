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
      level: "1",
      priority: "P0",
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
      level: "2",
      priority: "P0",
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
