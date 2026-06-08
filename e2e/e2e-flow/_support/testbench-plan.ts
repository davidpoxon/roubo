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

// The slices that own each leg of this journey, surfaced in a failing run so the
// divergence localises to an attributable slice (FR-020 / AC7). The mapping is
// this work unit's `blocked_by` / `covers` set from issue #438:
//   #414 settings toggle (TestBench enablement),
//   #416 bench-variant create (worktree binding + variant tab surface),
//   #418 create-a-TestBench flow (empty-slot option + spec-picker),
//   #419 TestBench review tab (focused slug/path + results panel).
export const OWNING_SLICES: Record<string, string> = {
  enable: "#414 (TestBench settings toggle)",
  emptySlotMenu: "#418 (create-a-TestBench flow: empty-slot option)",
  specPicker: "#418 (create-a-TestBench flow: spec-picker modal)",
  discoveredRow: "#418 (create-a-TestBench flow: spec discovery)",
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
