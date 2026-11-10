// @vitest-environment jsdom
/// <reference types="node" />
//
// Integration-level E2E test for the journey "Operator sits an escalated gate
// from call to close" (SB-TC-068, SB-FR-023, SB-FR-024, SB-FR-025, SB-FR-026,
// SB-FR-027, SB-US-009). It asserts the authoritative e2e_flow case SB-TC-068
// step for step, so a divergence is integration drift and not a
// re-specification.
//
// What runs for real on the client: the bench page (BenchDetail with the real
// Delivery tab and the real Test bench tab of the Spec Bench, with the
// sitting's phases, its Open and Close controls, and each escalated case on
// the TestBench case surface with its status control, its Not met evidence
// form and its Stage control), the real React Query hooks, the real `lib/api`
// request layer, the real notification stream hook, which shows each
// action-needed notification through the desktop bridge, and the real
// deep-link hook, which follows the link of a clicked notification.
//
// What runs for real on the server: every route whose answer a step asserts,
// mounted in-process on an express app as server/index.ts mounts it and reached
// through supertest, as the route suites do:
//   - server/routes/benches.ts creates the bench in launch mode and hands it to
//     the real session launcher (server/services/delivery-session-launcher.ts),
//     which mints the token in the real registry and builds the launch
//     descriptor;
//   - server/routes/delivery-hooks.ts takes the fake tooling's events, checks
//     the token, appends them to the event log and, on gate.reached, starts the
//     preparation of the gate's sitting through the real gate pin service
//     (server/services/gate-pin.ts): it pins the gate commit on a detached
//     worktree, restarts the components from the pin, smoke-checks the build
//     on the bench's port, and raises the bench's delivery-sitting notification
//     through the real notification service;
//   - server/routes/delivery.ts answers the snapshot with the sitting, opens
//     the prepared sitting and closes it through the same gate pin service, and
//     reads the cross-check through the real loader over real git;
//   - server/routes/testbench.ts serves the sitting's plan, replays a case's
//     state recipe in the pin through the real replayer
//     (server/services/state-recipe-replay.ts), and takes the operator's marks
//     through the real Spec Bench provider
//     (server/lib/specbench-testbench-adapter.ts) and the real results writer,
//     which stamps the operator's git identity as the author in the workspace's
//     test-results.json; a Not met mark files a fix unit below the gate, read
//     from the spec's work-units.json by the real work-unit loader, through
//     the real fix-issue filer (server/services/fix-issue-filer.ts) and the
//     real tracker-action gateway (server/services/tracker-action-gateway.ts).
//
// Git is real: the project checkout is a git repository with one branch per
// unit, each with its own build.txt, and the bench workspace is a worktree of it
// on main, whose build.txt is the live build. The gate pin is a git worktree
// at B's commit, the gate commit, so it holds B's build.txt. The operator's git
// identity is the checkout's own user.name and user.email. The project has no
// github.com `origin`, so the cross-check consults no GitHub.
//
// The build is real too: a local HTTP server on the bench's port serves the
// build.txt of the root its component was last started from, so the smoke check
// probes a real URL, and the test reads which build is live from it.
//
// The stand-ins sit below those routes: the bench manager claims the bench,
// provisions its workspace as a git worktree of the checkout, and stops and
// starts its one component, `web`, by pointing the build server at the
// component root the real Spec Bench variant host names (the pin while one is
// recorded, else the workspace); the launch executor records each launch and
// hands the descriptor to the fake delivery tooling; the integration plugin,
// which the real fix-issue filer reaches through the real tracker-action
// gateway (its capability preflight, its consent and capability guards, the
// create request and the block link all run), records each call and answers
// createIssue with the issue it minted, with the plugin installed, consented
// and active for the project; the notification stream's response is a fake that hands
// each frame to the client's fake EventSource; the desktop bridge records each
// notification it is asked to show and follows a clicked notification's link;
// and the state file writes are stubbed. Two reads that no step asserts, the
// spec list and the list of every project's benches, and the bench's terminal
// list, are answered by the stand-in in the shape of their bodies. A request to
// any other route answers 404 and is listed in the failure output. The hooks
// and components that the journey does not cross are stubbed as in the page
// suites.
//
// The Spec Bench is set up from `fixture-spec` in launch mode before the
// journey starts, with its live build up from the workspace. Started, the fake
// delivery tooling writes the record into the bench workspace with A, B and D
// done and C running, each unit on its branch at its head, the plan, the
// results, and the spec's work-units.json, which names the tracker issue of the
// gate after B. A state recipe names the commit it was recorded at, so it
// cannot sit inside the gate commit it names: the tooling records the first
// case's recipe in the pin checkout, beside the delivery record's folder, once
// the pin is in place.
//
// Failure-output contract: each SB-TC-068 step runs inside step(), which on a
// divergence reports the step that diverged, the expected versus the actual at
// that step, and the owning slice(s) from this journey's blocked-by set.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import express from "express";
import request from "supertest";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Bench, ComponentStatus, RegisteredProject } from "@roubo/shared";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  validateDeliveryRecord,
  type DeliveryEvent,
  type DeliveryRecord,
} from "@roubo/shared/delivery-observation-contract";
import {
  DELIVERY_CONTROLS_HOOK_PATH,
  DELIVERY_EVENT_HOOK_PATH,
  DELIVERY_RECORD_FILE,
  type DeliveryLaunchDescriptor,
  type DeliverySnapshotResponse,
} from "@roubo/shared/delivery-bench";
import {
  STATE_RECIPE_SCHEMA_ID,
  STATE_RECIPE_SCHEMA_VERSION,
  type StateRecipe,
} from "@roubo/shared/state-recipe-contract";
import {
  TEST_CASES_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_ID,
  TEST_RESULTS_SCHEMA_VERSION,
  type TestCasesPlan,
} from "@roubo/shared/testbench-contracts";
import { WORK_UNITS_SCHEMA_ID, WORK_UNITS_SCHEMA_VERSION } from "@roubo/shared/work-units-contract";
import { fourUnitRecord } from "../../test/delivery-fixtures";

// The fetch of the test process, kept before the client's fetch is stubbed: the
// smoke check, the recipe's http step and the test itself reach the build
// server with it.
const realFetch = globalThis.fetch;

// ── Stand-ins below the real routes ──

interface CreateBenchOptions {
  variant?: string;
  focusedSpecPath?: string;
  delivery?: { mode: string; decisionMode?: string };
}

// A call that the tracker-action gateway makes to the integration plugin.
interface TrackerCall {
  pluginId: string;
  method: string;
  params: unknown;
}

const routeServices = vi.hoisted(() => {
  class BenchError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
      this.name = "BenchError";
    }
  }
  return {
    BenchError,
    benches: [] as Bench[],
    project: undefined as unknown,
    createBench: undefined as
      ((projectId: string, branch?: string, options?: CreateBenchOptions) => Bench) | undefined,
    provisioned: new Map<number, Promise<void>>(),
    stopComponents: undefined as ((projectId: string, benchId: number) => void) | undefined,
    startComponents: undefined as
      ((projectId: string, benchId: number, names: string[]) => Bench | undefined) | undefined,
    // The project's integration plugin, consented and installed with the two
    // capabilities that filing a fix unit needs.
    trackerPluginId: "github-com",
    invokeTracker: undefined as
      ((pluginId: string, method: string, params: unknown) => unknown) | undefined,
  };
});

vi.mock("../../../../server/services/bench-manager.js", () => ({
  BenchError: routeServices.BenchError,
  getBench: vi.fn((projectId: string, benchId: number) =>
    routeServices.benches.find((bench) => bench.projectId === projectId && bench.id === benchId),
  ),
  getBenches: vi.fn((projectId: string) =>
    routeServices.benches.filter((bench) => bench.projectId === projectId),
  ),
  createBench: vi.fn((projectId: string, branch?: string, options?: CreateBenchOptions) => {
    if (routeServices.createBench === undefined) throw new Error("no bench manager stand-in");
    return routeServices.createBench(projectId, branch, options);
  }),
  whenWorkspaceProvisioned: vi.fn(
    (_projectId: string, benchId: number) =>
      routeServices.provisioned.get(benchId) ?? Promise.resolve(),
  ),
  isBenchLive: vi.fn(() => true),
  // The component stop and start that the gate pin service runs.
  stopAllComponents: vi.fn((projectId: string, benchId: number) => {
    if (routeServices.stopComponents === undefined) throw new Error("no component stand-in");
    routeServices.stopComponents(projectId, benchId);
    return Promise.resolve();
  }),
  startComponentsAndWait: vi.fn((projectId: string, benchId: number, names: string[]) => {
    if (routeServices.startComponents === undefined) throw new Error("no component stand-in");
    return Promise.resolve(routeServices.startComponents(projectId, benchId, names));
  }),
  // The fixture project's component declares no one-time setup.
  componentHasSetup: vi.fn(() => false),
}));
vi.mock("../../../../server/services/project-registry.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getProject: vi.fn(() => routeServices.project),
    resolveEnforceIssueDependencies: vi.fn(() => false),
  };
});
vi.mock("../../../../server/services/terminal.js", () => ({
  getSession: vi.fn(),
  getSessionScrollback: vi.fn(),
}));
vi.mock("../../../../server/services/state.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, updateBench: vi.fn(), loadSettings: vi.fn(() => ({})) };
});
// The tracker: the real fix-issue filer and the real tracker-action gateway run,
// and only the integration plugin they reach is a stand-in. The project's
// integration plugin is consented, so the gateway's consent guard passes.
vi.mock("../../../../server/services/plugin-consent-state.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    hasConsent: vi.fn((pluginId: string) => pluginId === routeServices.trackerPluginId),
  };
});
// The services of the benches routes that the journey does not cross.
vi.mock("../../../../server/services/tool-launcher.js", () => ({
  getResolvedTools: vi.fn(),
  executeTool: vi.fn(),
}));
vi.mock("../../../../server/services/issue-assignment.js", () => ({
  createBenchAndAssignFromIssue: vi.fn(),
}));
vi.mock("../../../../server/routes/plugin-route-helpers.js", () => ({
  getActivePluginOrRespond: vi.fn(),
  fetchPluginComments: vi.fn(),
  resolveActivePluginQuiet: vi.fn(),
}));
// The plugin host: its one installed plugin is the project's integration
// plugin, and a call to it reaches the stand-in tracker.
vi.mock("../../../../server/services/plugin-manager.js", () => ({
  invoke: vi.fn((pluginId: string, method: string, params: unknown) => {
    if (routeServices.invokeTracker === undefined) return Promise.resolve(undefined);
    return Promise.resolve(routeServices.invokeTracker(pluginId, method, params));
  }),
  listInstalled: vi.fn(() => [
    {
      id: routeServices.trackerPluginId,
      manifest: { capabilities: { supportsCreateIssue: true, supportsBlockingLinks: true } },
    },
  ]),
  getAgentManifests: vi.fn(() => []),
  getRecord: vi.fn(),
  getConnection: vi.fn(),
  HOST_API_VERSION: "1.4.0",
}));
vi.mock("../../../../server/services/start-gate.js", () => ({
  assertGateOpen: vi.fn(),
  fetchIssueForStart: vi.fn(),
}));
// The project's active integration plugin, which the filer and the gateway
// resolve.
vi.mock("../../../../server/services/active-plugin.js", () => ({
  resolveActivePlugin: vi.fn(() => ({
    pluginId: routeServices.trackerPluginId,
    integrationId: routeServices.trackerPluginId,
    pageSize: 50,
  })),
}));
vi.mock("../../../../server/services/git-state.js", () => ({
  getDirtyState: vi.fn(),
}));

// ── Stubs for what the journey does not cross ──

vi.mock("../../hooks/useProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useProjects")>();
  return { ...actual, useProjects: vi.fn() };
});
vi.mock("../../hooks/useProjectIntegration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useProjectIntegration")>();
  return {
    ...actual,
    useProjectIntegration: vi.fn(() => ({ data: undefined, isLoading: false, isError: false })),
  };
});
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  return {
    ...actual,
    useSettings: vi.fn(() => ({ settings: undefined, isLoading: false, updateSettings: vi.fn() })),
  };
});
vi.mock("../../hooks/useGlobalCap", () => ({
  useGlobalCap: vi.fn(() => ({
    current: 0,
    max: null,
    isCapped: false,
    isAtCap: false,
    isOverCap: false,
  })),
}));
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn() }),
}));
vi.mock("../../hooks/useClearingTracker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useClearingTracker")>();
  return {
    ...actual,
    useTeardownTracker: () => ({ register: vi.fn(), teardowns: new Map() }),
  };
});
vi.mock("../../hooks/useContainers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useContainers")>();
  return { ...actual, useUnassignContainer: () => ({ mutate: vi.fn(), isPending: false }) };
});
vi.mock("../../hooks/usePlugins", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/usePlugins")>();
  return {
    ...actual,
    usePlugins: () => ({ data: { hostApiVersion: "1.0.0", plugins: [] } }),
  };
});
vi.mock("../../hooks/useBenchIssue", () => ({
  useBenchIssue: vi.fn(() => ({ data: undefined })),
}));
vi.mock("../../hooks/useElapsed", () => ({ useElapsed: () => null }));
vi.mock("../MissingPluginDialog", () => ({ default: () => null }));
vi.mock("../EnablePluginPromptModal", () => ({ default: () => null }));
vi.mock("../settings/plugins/ConsentReviewDialog", () => ({ default: () => null }));
vi.mock("../ComponentStatusDot", () => ({ default: () => <span data-testid="status-dot" /> }));
vi.mock("../ToolButtons", () => ({ default: () => <span data-testid="tool-buttons" /> }));
vi.mock("../LogStream", () => ({ default: () => <div data-testid="log-stream" /> }));
vi.mock("../TerminalTabs", () => ({ default: () => <div data-testid="terminal-tabs" /> }));
vi.mock("../Terminal", () => ({ default: () => <div data-testid="live-terminal" /> }));
vi.mock("../AssignContainerModal", () => ({ default: () => null }));
vi.mock("../IssueTransitionDropdown", () => ({ default: () => null }));
vi.mock("../IssueAssignControl", () => ({ default: () => null }));
vi.mock("../testbench/TestBenchPanel", () => ({ default: () => null }));

import { useProjects } from "../../hooks/useProjects";
import { useNotificationStream } from "../../hooks/useNotificationStream";
import { useDeepLink } from "../../hooks/useDeepLink";
import BenchDetail from "../BenchDetail";

// ── Owning slices (this journey's blocked-by set) ──
//
// Reported on a divergence, so a red run names the slice that owns the step.
// OWNERS holds exactly the six slices of this journey's blocked-by set, each
// named by the exact title of its issue, and every step names the ones whose
// code it crosses:
//   - hostResolver owns each step that resolves the Spec Bench host: the steps
//     that start or stop the components at the root the variant host's
//     componentRoot names (1, 3 and 6) and the steps that reach the testbench
//     routes through the TestbenchHostResolver (2 to 5);
//   - contracts owns step 4, whose recipe is read against the state recipe
//     contract.
// ALSO_CROSSED names the slices a step also crosses that are not in the
// blocked-by set; the failure output labels them apart.
const OWNERS = {
  contracts: "'Delivery control and state recipe contracts'",
  hostResolver: "'TestbenchHostResolver replaces the four testbench variant guards'",
  pin: "'Gate pin service: detached worktree at the gate commit on the bench ports'",
  call: "'Call the operator to a gate only after the build is live and smoke-checked'",
  adapter: "'Specbench testbench adapter: marks on TestBench surfaces, evidence and fix units'",
  stage: "'State recipe replay through the stage route under the commit guard'",
} as const;

// Not from the blocked-by set: slices the journey also crosses.
const ALSO_CROSSED = {
  contract: "delivery observation contract in shared with generated schema and drift coverage",
  reducer: "delivery reducer and selectors shared by server and client",
  ingest: "token-gated event ingest, sequence checks and the delivery stream frame",
  launcher: "record loader, token registry and session launcher for launch and attach",
} as const;

type BlockedBySlice = keyof typeof OWNERS;
type CrossedSlice = keyof typeof ALSO_CROSSED;

function owners(blockedBy: BlockedBySlice[], crossed: CrossedSlice[] = []): string {
  const named = blockedBy.map((key) => OWNERS[key]).join("; ");
  if (crossed.length === 0) return named;
  const also = crossed.map((key) => ALSO_CROSSED[key]).join("; ");
  return `${named}\n  also crossed (not from the blocked-by set): ${also}`;
}

// ── Fixture project, repository, record and recipe (SB-TC-068 preconditions) ──

const PROJECT_ID = "demo";
const SPEC_SLUG = "fixture-spec";
const SPEC_FOLDER = `.specifications/${SPEC_SLUG}`;

// The operator, as the checkout's git identity names them.
const OPERATOR = { name: "Ada Operator", email: "ada@example.test" };

// Each unit's branch in the project checkout.
const BRANCH = { A: "fx/0-a", B: "fx/1-b", C: "fx/2-c", D: "fx/0-d" } as const;
type UnitId = keyof typeof BRANCH;

// Every commit is dated before the record's updated_at, so no branch head is
// newer than the record.
const COMMIT_DATE = "2026-01-05T09:00:00Z";

// The build each checkout serves: the workspace's live build on main, and the
// build of each unit's commit.
const LIVE_BUILD = "live build on main";
const UNIT_BUILD: Record<UnitId, string> = {
  A: "build of unit A",
  B: "build of unit B at the gate commit",
  C: "build of unit C",
  D: "build of unit D",
};

// The gate after B, escalated with two cases, and the gate after C's case.
const GATE = "gate-after-b";
const FIRST_CASE = "FX-TC-001";
const SECOND_CASE = "FX-TC-002";
const OTHER_GATE_CASE = "FX-TC-003";
const CASES = [FIRST_CASE, SECOND_CASE, OTHER_GATE_CASE];
const NOTE = "The banner never shows after the reload.";

// The gate's tracker issue, which the spec's work-units.json names, and the fix
// issue the tracker mints below it.
const GATE_TRACKER = {
  system: "github",
  ref: "12",
  url: "https://github.com/example/fixture/issues/12",
  blocked_by_refs: [],
} as const;
const GATE_REF = "example/fixture#12";
const FIX_REF = "example/fixture#13";

// The one component of the bench, and what the first case's recipe stages.
const COMPONENT = "web";
const STAGED_FILE = "state.txt";
const OBSERVATION = "The banner reads staged";

const plan: TestCasesPlan = {
  $schema: TEST_CASES_SCHEMA_ID,
  schemaVersion: "1.2.0",
  specSlug: SPEC_SLUG,
  cases: CASES.map((id) => ({
    id,
    title: `Case ${id}`,
    area: "fixture",
    level: 1,
    type: "functional",
    steps: [],
    tags: [],
    linked_requirement_ids: ["FX-FR-001"],
    linked_user_story_ids: [],
  })),
};

// The spec's work-units.json: the gate after B as a verify unit with its
// tracker issue.
const workUnits = {
  $schema: WORK_UNITS_SCHEMA_ID,
  schemaVersion: WORK_UNITS_SCHEMA_VERSION,
  specSlug: SPEC_SLUG,
  units: [
    {
      id: GATE,
      title: "Verify the gate after B",
      type: "task",
      kind: "verify",
      description: "The gate after B",
      acceptance_criteria: [],
      depends_on: [],
      covers: [],
      implements: {
        requirement_ids: [],
        user_story_ids: [],
        test_case_ids: [FIRST_CASE, SECOND_CASE],
      },
      tracker: GATE_TRACKER,
    },
  ],
};

// The scratch folder of a test, the project checkout in it, the folder the
// benches' workspaces go in, and each unit's head in the checkout.
let scratch: string;
let checkout: string;
let heads: Record<UnitId, string>;

function fixtureProject(): RegisteredProject {
  return {
    id: PROJECT_ID,
    repoPath: checkout,
    configValid: true,
    config: {
      project: { displayName: "Demo", name: "demo", repo: "" },
      layout: { type: "single-repo" },
      components: {},
      ports: {},
      benches: { max: 3 },
    } as unknown as RegisteredProject["config"],
    settings: { worktreeSource: { branchFromDefault: true, pullLatest: true } },
  } as RegisteredProject;
}

// Git with no user or system configuration, as a fixed author, dated
// COMMIT_DATE.
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture Author",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_AUTHOR_DATE: COMMIT_DATE,
      GIT_COMMITTER_DATE: COMMIT_DATE,
    },
  }).trim();
}

// Writes build.txt in the checkout and commits it on the branch checked out.
function commitBuild(content: string, message: string): string {
  writeFileSync(join(checkout, "build.txt"), `${content}\n`);
  git(checkout, "add", "build.txt");
  git(checkout, "commit", "--quiet", "-m", message);
  return git(checkout, "rev-parse", "HEAD");
}

// The checkout: a repository on main with the live build, and a branch per
// unit, A, B and C stacked in that order and D on main, each with its own
// build. Its own git identity is the operator's.
function initCheckout(): Record<UnitId, string> {
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--quiet", "--initial-branch=main");
  git(checkout, "config", "user.name", OPERATOR.name);
  git(checkout, "config", "user.email", OPERATOR.email);
  writeFileSync(join(checkout, "README.md"), "Fixture project\n");
  git(checkout, "add", "README.md");
  commitBuild(LIVE_BUILD, "Base");
  git(checkout, "checkout", "--quiet", "-b", BRANCH.A);
  const a = commitBuild(UNIT_BUILD.A, "Unit A");
  git(checkout, "checkout", "--quiet", "-b", BRANCH.B);
  const b = commitBuild(UNIT_BUILD.B, "Unit B");
  git(checkout, "checkout", "--quiet", "-b", BRANCH.C);
  const c = commitBuild(UNIT_BUILD.C, "Unit C");
  git(checkout, "checkout", "--quiet", "main");
  git(checkout, "checkout", "--quiet", "-b", BRANCH.D);
  const d = commitBuild(UNIT_BUILD.D, "Unit D");
  git(checkout, "checkout", "--quiet", "main");
  return { A: a, B: b, C: c, D: d };
}

// The conformant record fixture of four units A, B, C and D, a stack of A, B
// and C, and gates after B and after C, as the session writes it: A, B and D
// are done, C runs, each unit is on its branch at its head, and neither gate
// is decided yet.
function initialRecord(planHash: string): DeliveryRecord {
  const record = fourUnitRecord();
  const now = new Date().toISOString();
  const status: Record<string, string> = { A: "done", B: "done", C: "running", D: "done" };
  const gateCases: Record<string, string[]> = {
    [GATE]: [FIRST_CASE],
    "gate-after-c": [OTHER_GATE_CASE],
  };
  return {
    ...record,
    plan_hash: planHash,
    units: record.units.map((unit) => ({
      ...unit,
      status: status[unit.id] ?? unit.status,
      branch: BRANCH[unit.id as UnitId],
      head: heads[unit.id as UnitId],
    })),
    stack: {
      ...record.stack,
      gates: record.stack.gates.map((gate) => ({
        ...gate,
        status: "pending",
        cases: gateCases[gate.id] ?? gate.cases,
      })),
    },
    health: { status: "ok", checked_at: now },
    updated_at: now,
  };
}

// The results as the delivery left them: no case of either gate marked.
function initialResults(planHash: string): unknown {
  return {
    $schema: TEST_RESULTS_SCHEMA_ID,
    schemaVersion: TEST_RESULTS_SCHEMA_VERSION,
    planHash,
    caseResults: {},
    updatedAt: new Date().toISOString(),
  };
}

// The first case's state recipe, recorded at the gate commit: it writes the
// staged state into the checkout, checks that the build answers, and asks the
// operator to open it.
function firstCaseRecipe(buildUrl: string): StateRecipe {
  return {
    $schema: STATE_RECIPE_SCHEMA_ID,
    schemaVersion: STATE_RECIPE_SCHEMA_VERSION,
    caseId: FIRST_CASE,
    unitId: "B",
    commit: heads.B,
    requires: [],
    steps: [
      { kind: "command", command: `printf staged > ${STAGED_FILE}` },
      { kind: "http", method: "GET", url: buildUrl, expectedStatus: 200 },
      { kind: "open-url", url: buildUrl },
    ],
    observation: { description: OBSERVATION, url: buildUrl },
  };
}

// ── The build ──
//
// The bench's one component: a local HTTP server on the bench's port, which
// serves the build.txt of the root the component was last started from, and
// answers 503 while it is stopped.
class BuildServer {
  root: string | undefined;
  private readonly server = http.createServer((_req, res) => {
    const root = this.root;
    if (root === undefined) {
      res.statusCode = 503;
      res.end("stopped");
      return;
    }
    res.statusCode = 200;
    res.end(readFileSync(join(root, "build.txt"), "utf8").trim());
  });

  async listen(): Promise<number> {
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    return (this.server.address() as AddressInfo).port;
  }

  close(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

// What the live build on a port answers.
async function readBuild(url: string): Promise<string> {
  const res = await realFetch(url);
  const text = await res.text();
  if (res.status !== 200) throw new Error(`the build at ${url} answered ${res.status}: ${text}`);
  return text;
}

// ── The network stand-in ──

interface StandInResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function respond(status: number, body: unknown): StandInResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
  };
}

interface FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onopen: ((event: Event) => void) | null;
  readyState: number;
  close: () => void;
}

// What the launcher hands its executor, as the journey reads it.
interface LaunchRequest {
  projectId: string;
  benchId: number;
  workspacePath: string;
  specSlug: string;
  descriptor: DeliveryLaunchDescriptor;
}

interface LaunchExecutor {
  launch(request: LaunchRequest): Promise<{ sessionId?: string }>;
}

// The fake response the notification stream writes to: the part of an
// express Response that server/services/sse.ts uses.
interface StreamResponse {
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  on(event: string, listener: () => void): void;
}

// The real routers and services, loaded once the mocks above are in place. The
// specifier is built at run time so that the client's type check, whose root is
// client/src, does not take in the server's sources; the shape the journey
// uses of each module is declared here.
const SERVER_ROOT = "../../../../server";

interface ServerModules {
  benches: { default: express.Router };
  delivery: { default: express.Router };
  deliveryHooks: { default: express.Router; deliveryEventBodyParser: express.RequestHandler };
  testbench: { default: express.Router };
  specbenchTestbench: { registerSpecbenchTestbenchAdapter: () => void };
  variantHost: { specbenchVariantHost: { componentRoot: (bench: Bench) => string } };
  eventLog: { forgetDeliveryEventLog: () => void };
  controlOutbox: { forgetDeliveryControlMemory: () => void };
  launcher: {
    setDeliveryLaunchExecutor: (executor: LaunchExecutor) => void;
    resetDeliveryLaunchExecutor: () => void;
    whenDeliveryBound: (projectId: string, benchId: number) => Promise<void>;
  };
  sse: {
    addClient: (res: StreamResponse) => void;
    broadcastBenchStatus: (bench: Bench) => void;
    _resetClientsForTest: () => void;
  };
  crossCheck: {
    forgetDeliveryCrossCheck: (projectId?: string, benchId?: number) => void;
  };
  gatePin: {
    forgetGateSittingWatches: () => void;
    whenGateSittingPrepared: (bench: Bench) => Promise<void>;
  };
  testbenchStore: { computePlanHash: (plan: TestCasesPlan) => string };
}

async function loadServerModule<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ `${SERVER_ROOT}/${file}`)) as T;
}

async function loadServerModules(): Promise<ServerModules> {
  return {
    benches: await loadServerModule<ServerModules["benches"]>("routes/benches.js"),
    delivery: await loadServerModule<ServerModules["delivery"]>("routes/delivery.js"),
    deliveryHooks: await loadServerModule<ServerModules["deliveryHooks"]>(
      "routes/delivery-hooks.js",
    ),
    testbench: await loadServerModule<ServerModules["testbench"]>("routes/testbench.js"),
    specbenchTestbench: await loadServerModule<ServerModules["specbenchTestbench"]>(
      "lib/specbench-testbench-adapter.js",
    ),
    variantHost: await loadServerModule<ServerModules["variantHost"]>(
      "lib/specbench-variant-host.js",
    ),
    eventLog: await loadServerModule<ServerModules["eventLog"]>("services/delivery-event-log.js"),
    controlOutbox: await loadServerModule<ServerModules["controlOutbox"]>(
      "services/delivery-control-outbox.js",
    ),
    launcher: await loadServerModule<ServerModules["launcher"]>(
      "services/delivery-session-launcher.js",
    ),
    sse: await loadServerModule<ServerModules["sse"]>("services/sse.js"),
    crossCheck: await loadServerModule<ServerModules["crossCheck"]>(
      "services/delivery-cross-check-loader.js",
    ),
    gatePin: await loadServerModule<ServerModules["gatePin"]>("services/gate-pin.js"),
    testbenchStore:
      await loadServerModule<ServerModules["testbenchStore"]>("lib/testbench-store.js"),
  };
}

type SupertestMethod = (url: string) => request.Test;

const BASE = `/api/projects/${PROJECT_ID}`;

// The requests that the real routers answer.
const REAL_ROUTES: { methods: string[]; path: RegExp }[] = [
  { methods: ["GET", "POST"], path: new RegExp(`^${BASE}/benches$`) },
  { methods: ["GET"], path: new RegExp(`^${BASE}/benches/\\d+$`) },
  { methods: ["DELETE"], path: new RegExp(`^${BASE}/benches/\\d+/notifications$`) },
  {
    methods: ["GET", "POST", "PUT", "DELETE"],
    path: new RegExp(`^${BASE}/benches/\\d+/delivery(/.*)?$`),
  },
  { methods: ["GET", "PUT", "POST"], path: new RegExp(`^${BASE}/benches/\\d+/testbench(/.*)?$`) },
  { methods: ["POST"], path: new RegExp(`^${DELIVERY_EVENT_HOOK_PATH}$`) },
  { methods: ["GET"], path: new RegExp(`^${DELIVERY_CONTROLS_HOOK_PATH}$`) },
];

class RouboServerStandIn {
  unrouted: string[] = [];
  // Each request the real routers answered: its method, path and status.
  answered: { method: string; path: string; status: number }[] = [];
  launches: LaunchRequest[] = [];
  // Each stop and start of the bench's components, with the component root it
  // ran at, in order.
  componentCalls: { action: "stop" | "start"; root: string; names: string[] }[] = [];
  // Each call the tracker-action gateway made to the integration plugin.
  trackerCalls: TrackerCall[] = [];
  readonly build = new BuildServer();
  buildPort = 0;
  private readonly app = express();
  private readonly modules: ServerModules;
  private streams: FakeEventSource[] = [];
  private onLaunch: ((descriptor: DeliveryLaunchDescriptor) => void) | undefined;

  // The routers mounted as server/index.ts mounts them, behind the delivery
  // event parser and the global JSON parser.
  constructor(modules: ServerModules) {
    this.modules = modules;
    this.app.use(DELIVERY_EVENT_HOOK_PATH, modules.deliveryHooks.deliveryEventBodyParser);
    this.app.use(express.json({ limit: "210kb" }));
    this.app.use("/api/projects", modules.benches.default);
    this.app.use("/api/projects", modules.delivery.default);
    this.app.use("/api/projects", modules.testbench.default);
    this.app.use("/api/hooks", modules.deliveryHooks.default);
    routeServices.benches = [];
    routeServices.provisioned = new Map();
    routeServices.project = fixtureProject();
    routeServices.createBench = (projectId, _branch, options) =>
      this.createBench(projectId, options ?? {});
    routeServices.stopComponents = (projectId, benchId) => this.stopComponents(projectId, benchId);
    routeServices.startComponents = (projectId, benchId, names) =>
      this.startComponents(projectId, benchId, names);
    // The tracker mints the fix issue on createIssue and takes the block link
    // on addBlockedBy.
    routeServices.invokeTracker = (pluginId, method, params) => {
      if (method !== "createIssue" && method !== "addBlockedBy") return undefined;
      this.trackerCalls.push({ pluginId, method, params });
      if (method === "addBlockedBy") return undefined;
      return { ref: FIX_REF, url: "https://github.com/example/fixture/issues/13" };
    };
    modules.launcher.setDeliveryLaunchExecutor({
      launch: async (launch) => {
        this.launches.push(launch);
        this.onLaunch?.(launch.descriptor);
        return { sessionId: `delivery-session-${launch.benchId}-${this.launches.length}` };
      },
    });
  }

  async start(): Promise<void> {
    this.buildPort = await this.build.listen();
  }

  get buildUrl(): string {
    return `http://127.0.0.1:${this.buildPort}/`;
  }

  get benches(): Bench[] {
    return routeServices.benches;
  }

  setLaunchExecutor(onLaunch: (descriptor: DeliveryLaunchDescriptor) => void): void {
    this.onLaunch = onLaunch;
  }

  // A client EventSource: the real notification stream service holds a fake
  // response for it, which hands each `data:` frame to the source.
  openStream(): FakeEventSource {
    const closed: (() => void)[] = [];
    const source: FakeEventSource = {
      onmessage: null,
      onerror: null,
      onopen: null,
      readyState: 1,
      close: () => {
        source.readyState = 2;
        for (const listener of closed) listener();
      },
    };
    const response: StreamResponse = {
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (chunk) => {
        for (const line of chunk.split("\n")) {
          if (line.startsWith("data: ") && source.readyState === 1) {
            source.onmessage?.({ data: line.slice("data: ".length) } as MessageEvent);
          }
        }
        return true;
      },
      on: (name, listener) => {
        if (name === "close") closed.push(listener);
      },
    };
    this.modules.sse.addClient(response);
    this.streams.push(source);
    return source;
  }

  async close(): Promise<void> {
    for (const stream of this.streams) stream.close();
    this.modules.launcher.resetDeliveryLaunchExecutor();
    routeServices.stopComponents = undefined;
    routeServices.startComponents = undefined;
    routeServices.invokeTracker = undefined;
    await this.build.close();
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response | StandInResponse> {
    const url = new URL(String(input), "http://localhost");
    // The build on the bench's port is a real server: the smoke check and a
    // recipe's http step reach it.
    if (url.host === `127.0.0.1:${this.buildPort}`) return realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (REAL_ROUTES.some((route) => route.methods.includes(method) && route.path.test(path))) {
      const res = await this.routed(method, `${path}${url.search}`, init);
      this.answered.push({ method, path, status: res.status });
      return res;
    }
    if (method === "GET" && path === "/api/benches") {
      return respond(200, copy(routeServices.benches));
    }
    if (method === "GET" && path === `${BASE}/testbench/specs`) {
      return respond(200, { specs: [], invalid: [] });
    }
    if (method === "GET" && new RegExp(`^${BASE}/benches/\\d+/terminals$`).test(path)) {
      return respond(200, []);
    }
    this.unrouted.push(`${method} ${path}${url.search}`);
    return respond(404, { error: `The stand-in serves no ${method} ${path}`, code: "NOT_FOUND" });
  }

  // A request that the real routers answer, in-process, through supertest.
  private async routed(
    method: string,
    target: string,
    init: RequestInit | undefined,
  ): Promise<StandInResponse> {
    const agent = request(this.app) as unknown as Record<string, SupertestMethod>;
    let pending = agent[method.toLowerCase()](target);
    new Headers(init?.headers).forEach((value, name) => {
      pending = pending.set(name, value);
    });
    const res = typeof init?.body === "string" ? await pending.send(init.body) : await pending;
    return respond(res.status, res.body as unknown);
  }

  // The bench manager's create, below the real benches route: it claims the
  // bench, with its one component on its own port, and provisions its
  // workspace as a git worktree of the checkout.
  private createBench(projectId: string, options: CreateBenchOptions): Bench {
    const folder = resolve(checkout, options.focusedSpecPath ?? "");
    if (folder !== join(checkout, SPEC_FOLDER)) {
      throw new routeServices.BenchError(
        `Invalid focusedSpecPath: no spec folder ${String(options.focusedSpecPath)}`,
        "INVALID_FOCUS",
      );
    }
    const id = routeServices.benches.length + 1;
    const bench: Bench = {
      id,
      projectId,
      branch: `bench-${id}`,
      workspacePath: join(scratch, "workspaces", `bench-${id}`),
      status: "preparing",
      ports: { [COMPONENT]: this.buildPort },
      components: {
        [COMPONENT]: { name: COMPONENT, status: "stopped", setupComplete: true } as ComponentStatus,
      },
      createdAt: new Date().toISOString(),
      provisioningSteps: [],
      teardownSteps: [],
      notifications: [],
      variant: "specbench",
      focusedSpecPath: folder,
      ...(options.delivery && {
        deliveryBindMode: options.delivery.mode as Bench["deliveryBindMode"],
      }),
    };
    routeServices.benches.push(bench);
    routeServices.provisioned.set(id, this.provision(bench));
    return bench;
  }

  // The workspace, then the live build started from it.
  private provision(bench: Bench): Promise<void> {
    git(checkout, "worktree", "add", "--quiet", "-b", bench.branch, bench.workspacePath, "main");
    bench.status = "active";
    this.startComponents(bench.projectId, bench.id, [COMPONENT]);
    this.modules.sse.broadcastBenchStatus(bench);
    return Promise.resolve();
  }

  private benchOf(projectId: string, benchId: number): Bench {
    const bench = routeServices.benches.find((b) => b.projectId === projectId && b.id === benchId);
    if (bench === undefined) throw new Error(`the bench manager holds no bench ${benchId}`);
    return bench;
  }

  private stopComponents(projectId: string, benchId: number): void {
    const bench = this.benchOf(projectId, benchId);
    const root = this.modules.variantHost.specbenchVariantHost.componentRoot(bench);
    this.componentCalls.push({ action: "stop", root, names: Object.keys(bench.components) });
    for (const status of Object.values(bench.components)) {
      status.status = "stopped";
      status.url = undefined;
    }
    this.build.root = undefined;
  }

  // A start runs the component from the root the Spec Bench variant host names,
  // on the bench's own port.
  private startComponents(projectId: string, benchId: number, names: string[]): Bench {
    const bench = this.benchOf(projectId, benchId);
    const root = this.modules.variantHost.specbenchVariantHost.componentRoot(bench);
    this.componentCalls.push({ action: "start", root, names: [...names] });
    for (const name of names) {
      const status = bench.components[name];
      if (status === undefined) continue;
      status.status = "running";
      status.error = undefined;
      status.url = `http://127.0.0.1:${bench.ports[name]}/`;
    }
    this.build.root = root;
    return bench;
  }
}

// ── The fake delivery tooling ──
//
// It holds the launch descriptor the launch executor hands it. Started, it
// writes the record, the plan, the results and the work units into the spec
// folder of the bench workspace; then it posts its events to the event URL with
// the token, and records a case's state recipe in the pin checkout.
class FakeDeliveryTooling {
  descriptor: DeliveryLaunchDescriptor | undefined;
  private deliveryId = "";
  private nextSeq = 0;

  launched(descriptor: DeliveryLaunchDescriptor): void {
    this.descriptor = descriptor;
  }

  private held(): DeliveryLaunchDescriptor {
    const { descriptor } = this;
    if (descriptor === undefined) {
      throw new Error("the delivery session was never launched: the tooling holds no token");
    }
    return descriptor;
  }

  start(bench: Bench, record: DeliveryRecord, planHash: string): void {
    this.held();
    this.deliveryId = record.delivery_id;
    this.nextSeq = record.last_event_seq + 1;
    const folder = join(bench.workspacePath, SPEC_FOLDER);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "test-cases.json"), `${JSON.stringify(plan, null, 2)}\n`);
    writeFileSync(
      join(folder, "test-results.json"),
      `${JSON.stringify(initialResults(planHash), null, 2)}\n`,
    );
    writeFileSync(join(folder, "work-units.json"), `${JSON.stringify(workUnits, null, 2)}\n`);
    writeFileSync(join(folder, DELIVERY_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
  }

  recordRecipe(checkoutPath: string, recipe: StateRecipe): void {
    const folder = join(checkoutPath, SPEC_FOLDER, "state-recipes");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${recipe.caseId}.json`), `${JSON.stringify(recipe, null, 2)}\n`);
  }

  event(type: string, payload: Record<string, unknown>, unitId?: string): DeliveryEvent {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return {
      $schema: DELIVERY_EVENT_SCHEMA_ID,
      schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
      delivery_id: this.deliveryId,
      type,
      seq,
      ts: new Date().toISOString(),
      ...(unitId !== undefined && { unit_id: unitId }),
      payload,
    };
  }

  async post(events: DeliveryEvent[]): Promise<number> {
    const descriptor = this.held();
    const res = await fetch(descriptor.eventUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${descriptor.token}`,
      },
      body: JSON.stringify({ events }),
    });
    if (res.status !== 202) {
      throw new Error(
        `the event endpoint answered ${res.status}: ${JSON.stringify(await res.json())}`,
      );
    }
    return res.status;
  }
}

// ── The desktop bridge ──
//
// What the Electron preload hands the client: the notifications it was asked to
// show, and the link of a notification the operator clicks, which reaches the
// deep-link hook.
interface ShownNotification {
  title: string;
  body: string;
  routeTo?: string;
}

class DesktopBridge {
  shown: ShownNotification[] = [];
  private follow: ((url: string) => void) | undefined;

  install(): void {
    Object.defineProperty(window, "roubo", {
      configurable: true,
      value: {
        onDeepLink: (callback: (url: string) => void) => {
          this.follow = callback;
          return () => {
            if (this.follow === callback) this.follow = undefined;
          };
        },
        onNavigate: () => () => undefined,
        getAppVersion: () => Promise.resolve("0.0.0"),
        platform: "darwin",
        setTitleBarOverlayTheme: () => undefined,
        setBadgeCount: () => undefined,
        writeClipboard: () => Promise.resolve(true),
        showNotification: (req: ShownNotification) => {
          this.shown.push(req);
        },
      },
    });
  }

  uninstall(): void {
    Object.defineProperty(window, "roubo", { configurable: true, value: undefined });
  }

  // A click on a shown notification: the desktop shell hands its link to the
  // renderer's deep-link listener.
  click(notification: ShownNotification): void {
    const follow = this.follow;
    if (follow === undefined) throw new Error("no deep-link listener is registered");
    if (notification.routeTo === undefined) throw new Error("the notification carries no link");
    const url = notification.routeTo;
    act(() => follow(url));
  }
}

// ── Failure-output wrapper ──

let server: RouboServerStandIn;
let bridge: DesktopBridge;

async function step<T>(
  label: string,
  expectation: string,
  owningSlices: string,
  body: () => T | Promise<T>,
): Promise<T> {
  try {
    return await body();
  } catch (cause) {
    const actual = cause instanceof Error ? cause.message : String(cause);
    const unrouted =
      server.unrouted.length > 0 ? `\n  unserved requests: ${server.unrouted.join(", ")}` : "";
    throw new Error(
      `SB-TC-068 step diverged: "${label}"\n` +
        `  expected: ${expectation}\n` +
        `  actual:   ${actual}\n` +
        `  owning slice(s): ${owningSlices}${unrouted}`,
      { cause },
    );
  }
}

function AppHarness() {
  useNotificationStream();
  useDeepLink();
  return null;
}

// The bench page of the Spec Bench, which opens on its Delivery tab.
function renderBenchPage(benchId: number) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/projects/${PROJECT_ID}/benches/${benchId}`]}>
        <AppHarness />
        <Routes>
          <Route path="/projects/:projectId/benches/:benchId" element={<BenchDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let serverModules: ServerModules;

// The precondition: a Spec Bench set up from fixture-spec in launch mode, its
// session launched with the token, its record written and conformant, and its
// live build up from the workspace on the bench's port.
async function setUpLaunchModeSpecBench(tooling: FakeDeliveryTooling): Promise<Bench> {
  const res = await server.fetch(`${BASE}/benches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variant: "specbench",
      focusedSpecPath: SPEC_FOLDER,
      delivery: { mode: "launch" },
    }),
  });
  if (res.status !== 201) {
    throw new Error(`the create route answered ${res.status}: ${JSON.stringify(await res.json())}`);
  }
  const { id } = (await res.json()) as Bench;
  await serverModules.launcher.whenDeliveryBound(PROJECT_ID, id);
  const bench = server.benches.find((b) => b.id === id);
  if (bench === undefined) throw new Error(`the bench manager holds no bench ${id}`);
  expect(server.launches, "the launch-mode bench launched no session").toHaveLength(1);

  const planHash = serverModules.testbenchStore.computePlanHash(plan);
  const record = initialRecord(planHash);
  const validated = validateDeliveryRecord(record);
  expect(validated.ok, `the record fixture is not conformant: ${JSON.stringify(validated)}`).toBe(
    true,
  );
  tooling.start(bench, record, planHash);

  const snapshot = await readSnapshot(id);
  expect(snapshot.sitting, "precondition: the bench has a sitting already").toBeUndefined();
  expect(await readBuild(server.buildUrl), "precondition: the live build is not up").toBe(
    LIVE_BUILD,
  );
  return bench;
}

async function readSnapshot(benchId: number): Promise<DeliverySnapshotResponse> {
  const res = await server.fetch(`${BASE}/benches/${benchId}/delivery`);
  if (res.status !== 200) {
    throw new Error(
      `the snapshot read answered ${res.status}: ${JSON.stringify(await res.json())}`,
    );
  }
  return (await res.json()) as DeliverySnapshotResponse;
}

async function requestAnswered(
  benchId: number,
  method: string,
  route: string,
  status: number,
): Promise<void> {
  await waitFor(
    () =>
      expect(server.answered).toContainEqual({
        method,
        path: `${BASE}/benches/${benchId}/${route}`,
        status,
      }),
    { timeout: 5000 },
  );
}

function readResults(bench: Bench): {
  caseResults: Record<
    string,
    {
      statusOverride?: { status: string; author: { name: string; email: string } };
      notes?: { text: string }[];
    }
  >;
} {
  return JSON.parse(
    readFileSync(join(bench.workspacePath, SPEC_FOLDER, "test-results.json"), "utf8"),
  ) as ReturnType<typeof readResults>;
}

// The worktrees git lists for the checkout's repository.
function worktreePaths(): string[] {
  return git(checkout, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function testBenchTab(): HTMLElement {
  return screen.getByRole("tab", { name: /test bench/i });
}

// The phase the sitting's banner reads.
function sittingPhase(): string | undefined {
  const banner = within(screen.getByTestId("specbench-testbench")).getByRole("region", {
    name: `Gate ${GATE} sitting`,
  });
  return banner.dataset.state;
}

function sittingCases(): HTMLElement[] {
  const list = screen.getByRole("list", { name: `Escalated cases of gate ${GATE}` });
  return within(list).getAllByTestId("sitting-case");
}

// Chooses a case in the sitting's Cases list and returns the Case panel that
// shows it on the TestBench case surface.
async function openSittingCase(
  user: ReturnType<typeof userEvent.setup>,
  caseId: string,
): Promise<HTMLElement> {
  const found = sittingCases().find((item) => item.dataset.caseId === caseId);
  if (found === undefined) throw new Error(`the sitting lists no case ${caseId}`);
  await user.click(within(found).getByRole("button"));
  return screen.getByRole("region", { name: `Case ${caseId}` });
}

beforeAll(async () => {
  serverModules = await loadServerModules();
  serverModules.specbenchTestbench.registerSpecbenchTestbenchAdapter();
});

beforeEach(async () => {
  localStorage.clear();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  serverModules.crossCheck.forgetDeliveryCrossCheck();
  serverModules.gatePin.forgetGateSittingWatches();
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "spec-bench-gate-sitting-journey-")));
  checkout = join(scratch, "checkout");
  mkdirSync(join(scratch, "workspaces"));
  heads = initCheckout();
  server = new RouboServerStandIn(serverModules);
  await server.start();
  bridge = new DesktopBridge();
  bridge.install();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => server.fetch(input, init)),
  );
  vi.stubGlobal(
    "EventSource",
    vi.fn(function FakeEventSourceCtor() {
      return server.openStream();
    }),
  );
  vi.mocked(useProjects).mockReturnValue({
    data: [fixtureProject()],
    isLoading: false,
  } as unknown as ReturnType<typeof useProjects>);
});

afterEach(async () => {
  cleanup();
  serverModules.crossCheck.forgetDeliveryCrossCheck();
  serverModules.gatePin.forgetGateSittingWatches();
  await server.close();
  serverModules.sse._resetClientsForTest();
  bridge.uninstall();
  vi.unstubAllGlobals();
  serverModules.eventLog.forgetDeliveryEventLog();
  serverModules.controlOutbox.forgetDeliveryControlMemory();
  rmSync(scratch, { recursive: true, force: true });
});

describe("Spec Bench gate sitting journey", () => {
  it("SB-TC-068: Operator sits an escalated gate from call to close", async () => {
    const user = userEvent.setup();
    const tooling = new FakeDeliveryTooling();
    server.setLaunchExecutor((descriptor) => tooling.launched(descriptor));
    const bench = await setUpLaunchModeSpecBench(tooling);
    const workspace = bench.workspacePath;
    const pinPath = `${workspace}-pin`;
    renderBenchPage(bench.id);
    await waitFor(
      () =>
        expect(screen.getByRole("tab", { name: /delivery/i })).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      { timeout: 3000 },
    );
    expect(testBenchTab()).toHaveAttribute("aria-selected", "false");

    // Step 1 is a setup step: the gate after B is escalated with two cases and
    // reached, and the server brings its build up at the gate commit.
    await step(
      `1. Post gate.reached for ${GATE} with two escalated cases and bring the build up`,
      `the event endpoint accepts the batch, and the preparation of the sitting of ${GATE} settles`,
      owners(["call", "pin", "hostResolver"], ["ingest", "reducer", "launcher"]),
      async () => {
        await tooling.post([
          tooling.event("gate.changed", {
            gate_id: GATE,
            status: "escalated",
            cases: [FIRST_CASE, SECOND_CASE],
          }),
          tooling.event("gate.reached", { gate_id: GATE }, "B"),
        ]);
        await serverModules.gatePin.whenGateSittingPrepared(bench);
        // The tooling records the first case's recipe at the gate commit, in
        // the pin.
        tooling.recordRecipe(pinPath, firstCaseRecipe(server.buildUrl));
      },
    );

    await step(
      "2. Click the sitting notification",
      `a "Gate ready to sit" notification names ${GATE}, and clicking it opens the Test bench tab on the sitting of ${GATE} in its Ready to sit phase`,
      owners(["call", "adapter", "hostResolver"], ["reducer"]),
      async () => {
        await waitFor(
          () =>
            expect(bridge.shown).toContainEqual(
              expect.objectContaining({
                title: "Gate ready to sit",
                body: `Gate ${GATE} is ready to sit: its build is live and smoke-checked`,
              }),
            ),
          { timeout: 5000 },
        );
        const called = bridge.shown.filter((shown) => shown.title === "Gate ready to sit");
        expect(called, "the operator was called to the gate more than once").toHaveLength(1);
        const held = (server.benches[0]?.notifications ?? []).filter(
          (n) => n.type === "delivery-sitting",
        );
        expect(held.map((n) => n.dedupeKey)).toEqual([GATE]);

        bridge.click(called[0]);
        await waitFor(
          () =>
            expect(testBenchTab(), "the link did not open the Test bench tab").toHaveAttribute(
              "aria-selected",
              "true",
            ),
          { timeout: 3000 },
        );
        const sitting = await screen.findByTestId("specbench-testbench", {}, { timeout: 3000 });
        expect(
          await within(sitting).findByRole("heading", { name: `Gate ${GATE}` }, { timeout: 3000 }),
        ).toBeInTheDocument();
        await waitFor(() => expect(sittingPhase()).toBe("ready"), { timeout: 3000 });
        expect(within(sitting).getByRole("button", { name: "Open the sitting" })).toBeEnabled();
        const snapshot = await readSnapshot(bench.id);
        expect(snapshot.sitting).toMatchObject({
          gateId: GATE,
          state: "ready",
          smokeCheck: { passed: true },
        });
      },
    );

    await step(
      "3. Click Open sitting",
      `the pin is created at ${pinPath} on the gate commit ${heads.B}, the build restarts from it on the bench port ${String(server.buildPort)}, and the two cases ${FIRST_CASE} and ${SECOND_CASE} rise in one after the other`,
      owners(["pin", "call", "adapter", "hostResolver"]),
      async () => {
        await user.click(screen.getByRole("button", { name: "Open the sitting" }));
        await requestAnswered(bench.id, "POST", "delivery/sittings", 201);
        await waitFor(() => expect(sittingPhase()).toBe("open"), { timeout: 3000 });

        // The pin: a detached worktree of the repository at the gate commit.
        expect(bench.gatePin).toMatchObject({ gateId: GATE, workspacePath: pinPath });
        expect(existsSync(pinPath), "the pin worktree is not on disk").toBe(true);
        expect(worktreePaths()).toContain(pinPath);
        expect(git(pinPath, "rev-parse", "HEAD")).toBe(heads.B);
        expect(bench.deliverySitting).toMatchObject({ gateId: GATE, state: "open" });

        // The build: stopped in the workspace, restarted from the pin, and live
        // on the bench's port with the gate commit's build.
        expect(server.componentCalls).toEqual([
          { action: "start", root: workspace, names: [COMPONENT] },
          { action: "stop", root: workspace, names: [COMPONENT] },
          { action: "start", root: pinPath, names: [COMPONENT] },
        ]);
        const web = bench.components[COMPONENT];
        expect(web?.status).toBe("running");
        expect(new URL(web?.url ?? "http://invalid/").port).toBe(String(bench.ports[COMPONENT]));
        expect(await readBuild(server.buildUrl)).toBe(UNIT_BUILD.B);

        // The two cases rise in, in order, 40ms apart.
        await waitFor(() => expect(sittingCases()).toHaveLength(2), { timeout: 3000 });
        const items = sittingCases();
        expect(items.map((item) => item.dataset.caseId)).toEqual([FIRST_CASE, SECOND_CASE]);
        for (const item of items) expect(item).toHaveClass("animate-rise-in");
        expect(items.map((item) => item.style.animationDelay)).toEqual(["0ms", "40ms"]);
      },
    );

    await step(
      `4. Click Stage on the first case (${FIRST_CASE})`,
      `the recipe of ${FIRST_CASE} replays in the pin, step by step, and the staged state shows: staged at the gate commit ${heads.B}, look for "${OBSERVATION}"`,
      owners(["stage", "pin", "contracts", "hostResolver"]),
      async () => {
        const item = await openSittingCase(user, FIRST_CASE);
        await user.click(within(item).getByRole("button", { name: `Stage ${FIRST_CASE}` }));
        await requestAnswered(bench.id, "POST", `testbench/cases/${FIRST_CASE}/stage`, 200);

        const staged = await within(item).findByRole(
          "region",
          { name: `Staged state of ${FIRST_CASE}` },
          { timeout: 3000 },
        );
        expect(staged).toHaveTextContent(`${FIRST_CASE} is staged at commit ${heads.B}`);
        expect(staged).toHaveTextContent(`Look for: ${OBSERVATION}`);
        const steps = within(staged).getByRole("list", {
          name: `Steps of the state recipe of ${FIRST_CASE}`,
        });
        expect(
          within(steps)
            .getAllByRole("listitem")
            .map((li) => li.dataset.stepStatus),
        ).toEqual(["passed", "passed", "passed"]);

        // The recipe ran in the pinned checkout, not in the workspace.
        expect(readFileSync(join(pinPath, STAGED_FILE), "utf8")).toBe("staged");
        expect(existsSync(join(workspace, STAGED_FILE))).toBe(false);
      },
    );

    await step(
      `5. Mark the first case (${FIRST_CASE}) Met and the second (${SECOND_CASE}) Not met with a note`,
      `both marks land in test-results.json with the operator, ${OPERATOR.name}, as author, and a fix unit, ${FIX_REF}, is filed below ${GATE}, which shows blocked`,
      owners(["adapter", "hostResolver"]),
      async () => {
        const first = await openSittingCase(user, FIRST_CASE);
        await user.click(within(first).getByRole("button", { name: /Case status/ }));
        await user.click(await screen.findByRole("option", { name: "Passed" }));
        await requestAnswered(bench.id, "PUT", `testbench/cases/${FIRST_CASE}/status`, 200);

        const second = await openSittingCase(user, SECOND_CASE);
        await user.click(
          within(second).getByRole("button", { name: `Mark ${SECOND_CASE} Not met with evidence` }),
        );
        const form = within(second).getByRole("form", {
          name: `Not met evidence for ${SECOND_CASE}`,
        });
        await user.type(within(form).getByRole("textbox", { name: "Note" }), NOTE);
        await user.click(within(form).getByRole("button", { name: "Mark Not met" }));
        await requestAnswered(bench.id, "PUT", `testbench/cases/${SECOND_CASE}/status`, 200);

        // Both marks land in the workspace's test-results.json.
        const results = readResults(bench);
        expect(results.caseResults[FIRST_CASE]?.statusOverride).toMatchObject({
          status: "passed",
          author: OPERATOR,
        });
        expect(results.caseResults[SECOND_CASE]?.statusOverride).toMatchObject({
          status: "failed",
          author: OPERATOR,
        });
        expect(results.caseResults[SECOND_CASE]?.notes?.map((note) => note.text)).toContain(NOTE);

        // One fix unit is filed below the gate, for the second case only: the
        // tracker is asked to create the fix issue with the note, then to link
        // it as a blocker of the gate's issue.
        expect(server.trackerCalls).toEqual([
          {
            pluginId: routeServices.trackerPluginId,
            method: "createIssue",
            params: {
              repoFullName: "example/fixture",
              title: `Fix failed verify case ${SECOND_CASE} blocking gate ${GATE_REF}`,
              body: NOTE,
            },
          },
          {
            pluginId: routeServices.trackerPluginId,
            method: "addBlockedBy",
            params: { blockedRef: GATE_REF, blockerRef: FIX_REF },
          },
        ]);
        const snapshot = await readSnapshot(bench.id);
        expect(snapshot.sitting?.fixUnitBlockers).toEqual([
          expect.objectContaining({ caseId: SECOND_CASE, fixRef: FIX_REF }),
        ]);
        expect(snapshot.sitting?.blocked, "the gate does not read blocked").toBe(true);

        // The gate shows blocked on the sitting, by the fix unit of the case.
        await waitFor(
          () =>
            expect(screen.getByTestId("delivery-gate-sitting-blocked")).toHaveTextContent(
              `Blocked by a fix unit filed for cases marked Not met: ${FIX_REF} (${SECOND_CASE})`,
            ),
          { timeout: 3000 },
        );
        expect(screen.getByRole("region", { name: `Case ${SECOND_CASE}` })).toHaveTextContent(
          `Fix unit ${FIX_REF} blocks the gate.`,
        );
      },
    );

    await step(
      "6. Click Close sitting",
      `the pin at ${pinPath} is removed, and the live build returns from the workspace on the bench port ${String(server.buildPort)}`,
      owners(["pin", "call", "hostResolver"]),
      async () => {
        await user.click(screen.getByRole("button", { name: "Close the sitting" }));
        await requestAnswered(bench.id, "DELETE", "delivery/sittings/current", 204);

        // The pin is gone, from the disk, from git and from the bench.
        expect(existsSync(pinPath), "the pin worktree is still on disk").toBe(false);
        expect(worktreePaths()).not.toContain(pinPath);
        expect(bench.gatePin).toBeUndefined();
        expect(bench.deliverySitting).toBeUndefined();

        // The build was stopped in the pin and restarted from the workspace.
        expect(server.componentCalls.slice(-2)).toEqual([
          { action: "stop", root: pinPath, names: [COMPONENT] },
          { action: "start", root: workspace, names: [COMPONENT] },
        ]);
        expect(bench.components[COMPONENT]?.status).toBe("running");
        expect(await readBuild(server.buildUrl)).toBe(LIVE_BUILD);

        await waitFor(
          () =>
            expect(
              within(screen.getByTestId("specbench-testbench")).getByTestId("specbench-no-sitting"),
            ).toBeInTheDocument(),
          { timeout: 3000 },
        );
        // The marks outlive the sitting.
        const results = readResults(bench);
        expect(results.caseResults[FIRST_CASE]?.statusOverride?.status).toBe("passed");
        expect(results.caseResults[SECOND_CASE]?.statusOverride?.status).toBe("failed");
      },
    );
  }, 60_000);
});
