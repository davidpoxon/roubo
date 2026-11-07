// The delivery cross-check loader over a fixture workspace (SB-FR-030,
// SB-NFR-003, SB-NFR-005): when it refreshes, what a refresh costs in GitHub
// requests, the blocking-class notification, and a GitHub failure. Git, GitHub
// and the file watch are the loader's seams, so every source is a value here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bench } from "@roubo/shared";
import {
  DELIVERY_EVENT_SCHEMA_ID,
  DELIVERY_EVENT_SCHEMA_VERSION,
  DELIVERY_RECORD_SCHEMA_ID,
  DELIVERY_RECORD_SCHEMA_VERSION,
  type DeliveryEvent,
} from "@roubo/shared/delivery-observation-contract";

vi.mock("./bench-manager.js", () => ({
  isBenchLive: vi.fn(() => true),
  getBench: vi.fn(),
}));
vi.mock("./state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./state.js")>()),
  updateBench: vi.fn(),
}));
vi.mock("./sse.js", () => ({
  broadcast: vi.fn(),
  broadcastBenchDecisionMode: vi.fn(),
  broadcastDeliveryFrame: vi.fn(),
}));

import * as stateService from "./state.js";
import { forgetDeliveryEventLog } from "./delivery-event-log.js";
import {
  DELIVERY_CROSS_CHECK_BACKSTOP_MS,
  DELIVERY_CROSS_CHECK_DEBOUNCE_MS,
  DELIVERY_CROSS_CHECK_EVENT_TYPES,
  DELIVERY_CROSS_CHECK_FIRST_READ_MS,
  DELIVERY_CROSS_CHECK_THROTTLE_MS,
  deliveryCrossCheckRunCount,
  forgetDeliveryCrossCheck,
  parseForEachRef,
  parseGitHubRemote,
  readDeliveryCrossCheck,
  refreshDeliveryCrossCheckOnEvents,
  setDeliveryCrossCheckDeps,
  whenDeliveryCrossCheckIdle,
} from "./delivery-cross-check-loader.js";

// ── Fixture ──
//
// Four units A, B and C on one stack and D on its own, with gates after B and
// after C, as the case preconditions set them. Every source agrees with the
// record until a test changes the one value it needs.

const UPDATED_AT = "2026-10-16T09:30:00Z";
const BEFORE_UPDATE = "2026-10-16T09:00:00Z";
const BRANCH = { A: "fx/0-a", B: "fx/1-b", C: "fx/2-c", D: "fx/0-d" } as const;
const HEAD = { A: "a".repeat(40), B: "b".repeat(40), C: "c".repeat(40), D: "d".repeat(40) };
type UnitId = keyof typeof BRANCH;
const UNITS: UnitId[] = ["A", "B", "C", "D"];

function record(): unknown {
  const stackOf: Record<UnitId, string> = { A: "A", B: "A", C: "A", D: "D" };
  const layerOf: Record<UnitId, number> = { A: 0, B: 1, C: 2, D: 0 };
  return {
    $schema: DELIVERY_RECORD_SCHEMA_ID,
    schemaVersion: DELIVERY_RECORD_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    spec_slug: "fixture-spec",
    plan_hash: "plan-hash-1",
    mode: { value: "auto", pending: null },
    review: { status: "none", unreviewed: [] },
    stack: {
      stacks: { A: ["A", "B", "C"], D: ["D"] },
      // Provisional gates with no marks: no evaluator word to compare, so the
      // fixture's gates agree with any results.
      gates: [
        { id: "gate-after-b", after: ["B"], status: "provisional", cases: [] },
        { id: "gate-after-c", after: ["C"], status: "provisional", cases: [] },
      ],
    },
    units: UNITS.map((id) => ({
      id,
      title: `Unit ${id}`,
      status: "running",
      stack: stackOf[id],
      layer: layerOf[id],
      depends_on: [],
      branch: BRANCH[id],
      head: HEAD[id],
      pr_url: `https://github.com/example/fixture/pull/${id}`,
    })),
    decisions: [],
    steering: [],
    budget: { estimate_usd: 1, soft_budget_usd: 2, spent_usd: 0 },
    roles: {},
    health: { status: "ok", checked_at: UPDATED_AT },
    drift: [],
    seams: {},
    lifecycle: { state: "running", armed: true, started_at: BEFORE_UPDATE, ended_at: null },
    last_event_seq: 7,
    updated_at: UPDATED_AT,
  };
}

function event(seq: number, type: string): DeliveryEvent {
  return {
    $schema: DELIVERY_EVENT_SCHEMA_ID,
    schemaVersion: DELIVERY_EVENT_SCHEMA_VERSION,
    delivery_id: "fixture-delivery",
    type,
    seq,
    ts: "2026-10-16T09:40:00Z",
    payload: {},
  };
}

// The sources, which a test changes.
let prState: Record<UnitId, { state: string; merged_at: string | null }>;
let githubDown: boolean;
// A delay of every GitHub answer, on the test's timers.
let githubDelayMs: number;
// Replaces the pull-request query's body when set.
let pullsBody: unknown[] | undefined;
// Replaces the stacks resource's answer when set.
let stacksAnswer: (() => Response) | undefined;
let requests: { path: string; status: number; headers: Headers }[];
let fileChange: ((file: string) => void) | undefined;

const STACKS_ETAG = '"stacks-1"';

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (githubDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, githubDelayMs));
  }
  if (githubDown) {
    requests.push({ path: url.pathname, status: 0, headers });
    throw new TypeError("fetch failed");
  }
  let res: Response;
  if (url.pathname === "/repos/example/fixture/stacks") {
    res =
      stacksAnswer !== undefined
        ? stacksAnswer()
        : headers.get("if-none-match") === STACKS_ETAG
          ? respond(304, null)
          : respond(
              200,
              [
                { name: "A", branches: [BRANCH.A, BRANCH.B, BRANCH.C] },
                { name: "D", branches: [BRANCH.D] },
              ],
              { etag: STACKS_ETAG },
            );
  } else if (url.pathname === "/repos/example/fixture/pulls") {
    const base: Record<UnitId, string> = { A: "main", B: BRANCH.A, C: BRANCH.B, D: "main" };
    res = respond(
      200,
      pullsBody ??
        UNITS.map((id) => ({
          state: prState[id].state,
          merged_at: prState[id].merged_at,
          head: { ref: BRANCH[id] },
          base: { ref: base[id] },
          html_url: `https://github.com/example/fixture/pull/${id}`,
        })),
    );
  } else {
    res = respond(404, { message: "Not Found" });
  }
  requests.push({ path: url.pathname, status: res.status, headers });
  return res;
}

let tmp: string;
let specFolder: string;
let bench: Bench;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-crosscheck-"));
  const workspace = path.join(tmp, "workspace");
  specFolder = path.join(workspace, ".specifications", "fixture-spec");
  fs.mkdirSync(specFolder, { recursive: true });
  fs.writeFileSync(
    path.join(specFolder, "delivery-observation.json"),
    `${JSON.stringify(record(), null, 2)}\n`,
  );
  bench = {
    id: 1,
    projectId: "demo",
    variant: "specbench",
    focusedSpecPath: "/repo/.specifications/fixture-spec",
    workspacePath: workspace,
    components: {},
    notifications: [],
  } as unknown as Bench;
  prState = {
    A: { state: "open", merged_at: null },
    B: { state: "open", merged_at: null },
    C: { state: "open", merged_at: null },
    D: { state: "open", merged_at: null },
  };
  githubDown = false;
  githubDelayMs = 0;
  pullsBody = undefined;
  stacksAnswer = undefined;
  requests = [];
  fileChange = undefined;
  vi.mocked(stateService.updateBench).mockReset();
  setDeliveryCrossCheckDeps({
    readGit: async () => {
      const git: Record<string, { localHead: string; remoteHead: string; committedAt: string }> =
        {};
      for (const id of UNITS) {
        git[BRANCH[id]] = { localHead: HEAD[id], remoteHead: HEAD[id], committedAt: BEFORE_UPDATE };
      }
      return git;
    },
    resolveGitHubRepository: async () => ({ owner: "example", repo: "fixture" }),
    githubToken: async () => "token",
    fetch: fakeFetch,
    watch: (_folder, onChange) => {
      fileChange = onChange;
      return { close: () => (fileChange = undefined) };
    },
    now: () => Date.now(),
  });
  forgetDeliveryEventLog();
});

afterEach(() => {
  forgetDeliveryCrossCheck();
  setDeliveryCrossCheckDeps();
  forgetDeliveryEventLog();
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runs(): number {
  return deliveryCrossCheckRunCount(bench.projectId, bench.id);
}

async function idle(): Promise<void> {
  await whenDeliveryCrossCheckIdle(bench.projectId, bench.id);
}

async function refreshOnEvent(seq: number, type = "unit.boundary"): Promise<void> {
  await refreshDeliveryCrossCheckOnEvents(bench, [event(seq, type)]);
}

function crossCheckNotifications() {
  return bench.notifications.filter((n) => n.type === "delivery-crosscheck");
}

describe("SB-TC-071: when the cross-check refreshes", () => {
  it("SB-TC-071 runs once on load, once per refreshing event, once per debounced file change and once on the 60-second backstop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    // Step 1: the load.
    await readDeliveryCrossCheck(bench);
    expect(runs()).toBe(1);
    // A second read runs nothing.
    await readDeliveryCrossCheck(bench);
    expect(runs()).toBe(1);

    // Step 2: one run per unit.boundary, pr.submitted and gate.reached event,
    // and per unit.changed and gate.changed of the observation contract.
    await refreshOnEvent(8, "unit.boundary");
    expect(runs()).toBe(2);
    await refreshOnEvent(9, "pr.submitted");
    expect(runs()).toBe(3);
    await refreshOnEvent(10, "gate.reached");
    expect(runs()).toBe(4);
    await refreshOnEvent(11, "unit.changed");
    expect(runs()).toBe(5);
    await refreshOnEvent(12, "gate.changed");
    expect(runs()).toBe(6);
    // Another event type runs none.
    await refreshOnEvent(13, "decision.raised");
    await refreshOnEvent(14, "budget.changed");
    expect(runs()).toBe(6);

    // Step 3: the record, then the results file, each one run after the
    // 500 ms debounce. A file of another name runs none.
    fileChange?.("delivery-observation.json");
    await vi.advanceTimersByTimeAsync(499);
    expect(runs()).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    await idle();
    expect(runs()).toBe(7);

    await vi.advanceTimersByTimeAsync(30_000);
    fileChange?.("test-results.json");
    fileChange?.("notes.txt");
    await vi.advanceTimersByTimeAsync(500);
    await idle();
    expect(runs()).toBe(8);

    // Step 4: 60 quiet seconds give one backstop run.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(runs()).toBe(8);
    await vi.advanceTimersByTimeAsync(1);
    await idle();
    expect(runs()).toBe(9);
  });

  it("SB-TC-071 debounces file changes by 500 ms, throttles to 30 seconds and backstops after 60 seconds, as the spec sets them", () => {
    expect(DELIVERY_CROSS_CHECK_DEBOUNCE_MS).toBe(500);
    expect(DELIVERY_CROSS_CHECK_THROTTLE_MS).toBe(30_000);
    expect(DELIVERY_CROSS_CHECK_BACKSTOP_MS).toBe(60_000);
  });

  it("SB-TC-071 runs one refresh for each refreshing event type, the contract's unit.changed and gate.changed included", async () => {
    await readDeliveryCrossCheck(bench);
    expect(runs()).toBe(1);
    const types = ["unit.boundary", "pr.submitted", "gate.reached", "unit.changed", "gate.changed"];
    expect([...DELIVERY_CROSS_CHECK_EVENT_TYPES].sort()).toEqual([...types].sort());
    let seq = 8;
    for (const type of types) {
      const before = runs();
      await refreshOnEvent(seq++, type);
      expect(runs(), type).toBe(before + 1);
    }
  });

  it("SB-TC-071 runs nothing on an event before a read arms the bench", async () => {
    await refreshOnEvent(8, "unit.boundary");
    expect(runs()).toBe(0);
  });
});

describe("SB-TC-072: the first appearance of a blocking class", () => {
  it("SB-TC-072 raises one notification naming the class, none on repeats, a new one after a clear, and records the class and time", async () => {
    await readDeliveryCrossCheck(bench);
    expect(crossCheckNotifications()).toEqual([]);
    expect(bench.deliveryFirstSeenBlocking).toBeUndefined();

    // Step 1: inject pr-state-differs (B's pull request closed unmerged).
    prState.B = { state: "closed", merged_at: null };
    await refreshOnEvent(8);
    const first = crossCheckNotifications();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      dedupeKey: "pr-state-differs",
      priority: "action-needed",
      metadata: { class: "pr-state-differs" },
    });

    // Step 4 (read with step 1): the bench records the class and the time.
    const seenAt = bench.deliveryFirstSeenBlocking;
    expect(seenAt).toBeDefined();
    expect(Number.isNaN(Date.parse(seenAt ?? ""))).toBe(false);
    expect(bench.deliveryFirstSeenBlockingClass).toBe("pr-state-differs");
    expect(stateService.updateBench).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryFirstSeenBlocking: seenAt,
        deliveryFirstSeenBlockingClass: "pr-state-differs",
      }),
    );

    // Step 2: three more refreshes raise nothing more.
    await refreshOnEvent(9);
    await refreshOnEvent(10);
    await refreshOnEvent(11);
    expect(crossCheckNotifications()).toHaveLength(1);
    expect(crossCheckNotifications()[0]?.id).toBe(first[0]?.id);
    expect(bench.deliveryFirstSeenBlocking).toBe(seenAt);

    // Step 3: cleared, then injected again: a new notification.
    prState.B = { state: "open", merged_at: null };
    await refreshOnEvent(12);
    expect(crossCheckNotifications()).toEqual([]);
    expect(bench.deliveryFirstSeenBlocking).toBeUndefined();
    expect(bench.deliveryFirstSeenBlockingClass).toBeUndefined();

    prState.B = { state: "closed", merged_at: null };
    await refreshOnEvent(13);
    const again = crossCheckNotifications();
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(first[0]?.id);
    expect(again[0]?.metadata).toMatchObject({ class: "pr-state-differs" });
    expect(bench.deliveryFirstSeenBlockingClass).toBe("pr-state-differs");
  });

  it("SB-TC-072 raises none again after a restart while the class stays", async () => {
    await readDeliveryCrossCheck(bench);
    prState.B = { state: "closed", merged_at: null };
    await refreshOnEvent(8);
    expect(crossCheckNotifications()).toHaveLength(1);

    // A restart forgets the loader's memory, not the bench's notifications.
    forgetDeliveryCrossCheck();
    await readDeliveryCrossCheck(bench);
    expect(crossCheckNotifications()).toHaveLength(1);
  });

  it("SB-TC-072 dismisses the notification the bench kept when the first refresh after a restart finds the class cleared", async () => {
    await readDeliveryCrossCheck(bench);
    prState.B = { state: "closed", merged_at: null };
    await refreshOnEvent(8);
    expect(crossCheckNotifications()).toHaveLength(1);
    expect(bench.deliveryFirstSeenBlocking).toBeDefined();

    // The restart forgets the loader's memory; the seen classes come from the
    // bench's notifications, and the class has cleared meanwhile.
    forgetDeliveryCrossCheck();
    prState.B = { state: "open", merged_at: null };
    await readDeliveryCrossCheck(bench);
    expect(crossCheckNotifications()).toEqual([]);
    expect(bench.deliveryFirstSeenBlocking).toBeUndefined();
    expect(bench.deliveryFirstSeenBlockingClass).toBeUndefined();
  });

  it("SB-TC-072 keeps the notification and the first-seen time of a GitHub class when GitHub fails on the first refresh after a restart", async () => {
    await readDeliveryCrossCheck(bench);
    prState.B = { state: "closed", merged_at: null };
    await refreshOnEvent(8);
    const notified = crossCheckNotifications();
    expect(notified).toHaveLength(1);
    const seenAt = bench.deliveryFirstSeenBlocking;
    expect(seenAt).toBeDefined();

    // A restart, then GitHub down on the load refresh: the class is not known
    // to have cleared, so nothing is dismissed and nothing is cleared.
    forgetDeliveryCrossCheck();
    githubDown = true;
    const read = await readDeliveryCrossCheck(bench);
    expect(read.sourceError?.source).toBe("github");
    expect(crossCheckNotifications().map((n) => n.id)).toEqual([notified[0]?.id]);
    expect(bench.deliveryFirstSeenBlocking).toBe(seenAt);
    expect(bench.deliveryFirstSeenBlockingClass).toBe("pr-state-differs");

    // GitHub back, the class still there: no new notification.
    githubDown = false;
    await refreshOnEvent(9);
    expect(crossCheckNotifications().map((n) => n.id)).toEqual([notified[0]?.id]);
    expect(bench.deliveryFirstSeenBlocking).toBe(seenAt);
  });
});

describe("SB-TC-074: the first read after a restart", () => {
  it("SB-TC-074 answers within 4 seconds with the git and results classes while GitHub is slower than 5 seconds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    expect(DELIVERY_CROSS_CHECK_FIRST_READ_MS).toBe(4_000);
    // D's branch is missing (git) and B's pull request closed (GitHub), and
    // each GitHub answer takes 6 seconds.
    setDeliveryCrossCheckDeps({
      readGit: async () => {
        const git: Record<string, { localHead: string; remoteHead: string; committedAt: string }> =
          {};
        for (const id of UNITS) {
          if (id === "D") continue;
          git[BRANCH[id]] = {
            localHead: HEAD[id],
            remoteHead: HEAD[id],
            committedAt: BEFORE_UPDATE,
          };
        }
        return git;
      },
      resolveGitHubRepository: async () => ({ owner: "example", repo: "fixture" }),
      githubToken: async () => "token",
      fetch: fakeFetch,
      watch: () => ({ close: () => undefined }),
    });
    prState.B = { state: "closed", merged_at: null };
    githubDelayMs = 6_000;

    const started = Date.now();
    let answered: Awaited<ReturnType<typeof readDeliveryCrossCheck>> | undefined;
    let answeredAt = 0;
    void readDeliveryCrossCheck(bench).then((read) => {
      answered = read;
      answeredAt = Date.now();
    });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(answered).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toBeDefined();
    expect(answeredAt - started).toBe(4_000);
    expect(answered?.disagreements.map((d) => d.class)).toEqual(["branch-missing"]);
    expect(answered?.sourceError).toBeNull();
    expect(answered?.refreshedAt).not.toBeNull();

    // GitHub answers later, and the next read lists its class too.
    await vi.advanceTimersByTimeAsync(12_000);
    await idle();
    const later = await readDeliveryCrossCheck(bench);
    expect(later.disagreements.map((d) => d.class)).toEqual(["branch-missing", "pr-state-differs"]);
  });
});

describe("SB-TC-073: the cost of a refresh", () => {
  it("SB-TC-073 makes at most one stacks request and one pull-request query per refresh, and unchanged stacks answer 304", async () => {
    await readDeliveryCrossCheck(bench);
    for (let seq = 8; seq < 17; seq += 1) await refreshOnEvent(seq);
    expect(runs()).toBe(10);

    const stacks = requests.filter((r) => r.path.endsWith("/stacks"));
    const pulls = requests.filter((r) => r.path.endsWith("/pulls"));
    expect(stacks).toHaveLength(10);
    expect(pulls).toHaveLength(10);
    expect(requests).toHaveLength(20);
    expect(stacks[0]?.status).toBe(200);
    expect(stacks.slice(1).every((r) => r.status === 304)).toBe(true);
    // The 304 reuses the stacks body: no order disagreement appears.
    const read = await readDeliveryCrossCheck(bench);
    expect(read.disagreements).toEqual([]);
  });

  it("SB-TC-073 sends the token as a Bearer header and the stacks ETag as If-None-Match", async () => {
    await readDeliveryCrossCheck(bench);
    await refreshOnEvent(8);
    const stacks = requests.filter((r) => r.path.endsWith("/stacks"));
    const pulls = requests.filter((r) => r.path.endsWith("/pulls"));
    expect(requests.every((r) => r.headers.get("authorization") === "Bearer token")).toBe(true);
    expect(stacks[0]?.headers.get("if-none-match")).toBeNull();
    expect(stacks[1]?.headers.get("if-none-match")).toBe(STACKS_ETAG);
    expect(pulls.every((r) => r.headers.get("if-none-match") === null)).toBe(true);
  });

  it("SB-TC-073 sends no Authorization header when no GitHub token is stored", async () => {
    setDeliveryCrossCheckDeps({
      readGit: async () => ({}),
      resolveGitHubRepository: async () => ({ owner: "example", repo: "fixture" }),
      githubToken: async () => null,
      fetch: fakeFetch,
      watch: () => ({ close: () => undefined }),
    });
    await readDeliveryCrossCheck(bench);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.headers.get("authorization") === null)).toBe(true);
  });

  it("SB-TC-073 reads a stacks body that lists the stacks under a stacks key", async () => {
    stacksAnswer = () =>
      respond(200, {
        stacks: [
          { name: "A", branches: [{ name: BRANCH.A }, { ref: BRANCH.C }, { branch: BRANCH.B }] },
          { name: "D", branches: [BRANCH.D] },
        ],
      });
    const read = await readDeliveryCrossCheck(bench);
    expect(read.sourceError).toBeNull();
    expect(read.disagreements).toEqual([
      expect.objectContaining({
        class: "layer-order-differs",
        stack: "A",
        claimed: [BRANCH.A, BRANCH.B, BRANCH.C],
        observed: [BRANCH.A, BRANCH.C, BRANCH.B],
      }),
    ]);
  });

  it("SB-TC-073 logs a stacks 404 once per bench and compares no stack order, with no source error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      stacksAnswer = () => respond(404, { message: "Not Found" });
      const read = await readDeliveryCrossCheck(bench);
      await refreshOnEvent(8);
      expect(read).toMatchObject({ disagreements: [], sourceError: null });
      const logged = warn.mock.calls.filter((call) => String(call[0]).includes("stacks request"));
      expect(logged).toHaveLength(1);
      expect(String(logged[0]?.[0])).toMatch(/example\/fixture with 404/);
      // The 404 drops the ETag, so the next request sends none.
      const stacks = requests.filter((r) => r.path.endsWith("/stacks"));
      expect(stacks.map((r) => r.headers.get("if-none-match"))).toEqual([null, null]);
    } finally {
      warn.mockRestore();
    }
  });

  it("SB-TC-073 leaves a unit unobserved, not absent, when the full pull-request page does not hold its branch", async () => {
    // One hundred pull requests, the most recently updated: A, C and D, and
    // 97 of other branches. B's open pull request is older than the page, and
    // C targets main while B's merge state is unknown.
    const others = Array.from({ length: 97 }, (_, index) => ({
      state: "closed",
      merged_at: "2026-10-16T09:10:00Z",
      head: { ref: `other/${index}` },
      base: { ref: "main" },
      html_url: `https://github.com/example/fixture/pull/${1000 + index}`,
    }));
    const listed = (id: UnitId, baseRef: string) => ({
      state: "open",
      merged_at: null,
      head: { ref: BRANCH[id] },
      base: { ref: baseRef },
      html_url: `https://github.com/example/fixture/pull/${id}`,
    });
    pullsBody = [listed("A", "main"), listed("C", "main"), listed("D", "main"), ...others];
    expect(pullsBody).toHaveLength(100);
    const read = await readDeliveryCrossCheck(bench);
    expect(read.sourceError).toBeNull();
    expect(read.disagreements).toEqual([]);
    expect(crossCheckNotifications()).toEqual([]);
    expect(requests.filter((r) => r.path.endsWith("/pulls"))).toHaveLength(1);

    // A page that is not full does hold every pull request: a branch missing
    // from it has none, and that disagrees.
    pullsBody = [listed("A", "main"), listed("C", BRANCH.B), listed("D", "main")];
    await refreshOnEvent(8);
    const short = await readDeliveryCrossCheck(bench);
    expect(short.disagreements).toEqual([
      expect.objectContaining({ class: "pr-state-differs", unitId: "B", observed: null }),
    ]);
  });

  it("SB-TC-073 runs file-change and backstop refreshes at most once in any 30-second window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const times: number[] = [];
    setDeliveryCrossCheckDeps({
      readGit: async () => {
        times.push(Date.now());
        const git: Record<string, { localHead: string; remoteHead: string; committedAt: string }> =
          {};
        for (const id of UNITS) {
          git[BRANCH[id]] = {
            localHead: HEAD[id],
            remoteHead: HEAD[id],
            committedAt: BEFORE_UPDATE,
          };
        }
        return git;
      },
      resolveGitHubRepository: async () => ({ owner: "example", repo: "fixture" }),
      githubToken: async () => "token",
      fetch: fakeFetch,
      watch: (_folder, onChange) => {
        fileChange = onChange;
        return { close: () => (fileChange = undefined) };
      },
    });
    await readDeliveryCrossCheck(bench);
    times.length = 0;
    const t0 = Date.now();

    // Step 2: the results file touched five times in 10 seconds, every 2.5 s
    // from t0.
    for (let touch = 0; touch < 5; touch += 1) {
      fileChange?.("test-results.json");
      await vi.advanceTimersByTimeAsync(2_500);
    }
    // To t0 + 40 s: the first touch runs after the debounce, at t0 + 0.5 s, and
    // the other four share one run at the end of its 30-second window, at
    // t0 + 30.5 s.
    await vi.advanceTimersByTimeAsync(40_000 - 12_500);
    await idle();
    expect(times.map((t) => t - t0)).toEqual([500, 30_500]);

    // Then the backstop, 60 seconds after the last run, at t0 + 90.5 s.
    await vi.advanceTimersByTimeAsync(60_000);
    await idle();
    expect(times.map((t) => t - t0)).toEqual([500, 30_500, 90_500]);
  });
});

describe("SB-TC-075: a GitHub failure", () => {
  it("SB-TC-075 keeps the last list with a source error naming GitHub, and clears it on the next refresh that reads GitHub", async () => {
    prState.B = { state: "closed", merged_at: null };
    const before = await readDeliveryCrossCheck(bench);
    expect(before.sourceError).toBeNull();
    expect(before.disagreements.map((d) => d.class)).toEqual(["pr-state-differs"]);

    // Step 1: GitHub fails, and the refresh keeps the previous list.
    githubDown = true;
    await refreshOnEvent(8);
    const failed = await readDeliveryCrossCheck(bench);
    expect(failed.disagreements).toEqual(before.disagreements);
    expect(failed.sourceError).toEqual({
      source: "github",
      message: expect.stringContaining("GitHub") as unknown as string,
    });
    // The class kept through the failure stays found: no new notification.
    expect(crossCheckNotifications()).toHaveLength(1);

    // Step 2: GitHub restored, and the error clears.
    githubDown = false;
    prState.B = { state: "open", merged_at: null };
    await refreshOnEvent(9);
    const restored = await readDeliveryCrossCheck(bench);
    expect(restored.sourceError).toBeNull();
    expect(restored.disagreements).toEqual([]);
  });

  it("SB-TC-075 names a GitHub error status as the source error", async () => {
    await readDeliveryCrossCheck(bench);
    setDeliveryCrossCheckDeps({
      readGit: async () => ({}),
      resolveGitHubRepository: async () => ({ owner: "example", repo: "fixture" }),
      githubToken: async () => null,
      fetch: async () => respond(502, { message: "Bad Gateway" }),
      watch: () => ({ close: () => undefined }),
    });
    await refreshOnEvent(8);
    const read = await readDeliveryCrossCheck(bench);
    expect(read.sourceError?.source).toBe("github");
    expect(read.sourceError?.message).toMatch(/GitHub answered the stacks request with 502/);
    // git still reads fresh: every branch is missing now.
    expect(read.disagreements.map((d) => d.class)).toEqual([
      "branch-missing",
      "branch-missing",
      "branch-missing",
      "branch-missing",
    ]);
  });
});

describe("the loader's readings", () => {
  it("reads local and origin branches from one for-each-ref", () => {
    const observation = parseForEachRef(
      [
        `refs/heads/${BRANCH.A}\t${HEAD.A}\t2026-10-16T09:00:00+00:00`,
        `refs/remotes/origin/${BRANCH.A}\t${HEAD.B}\t2026-10-16T09:00:00+00:00`,
        `refs/remotes/origin/HEAD\t${HEAD.C}\t2026-10-16T09:00:00+00:00`,
        `refs/heads/${BRANCH.D}\t${HEAD.D}\t2026-10-16T09:05:00+00:00`,
        "",
      ].join("\n"),
    );
    expect(observation).toEqual({
      [BRANCH.A]: {
        localHead: HEAD.A,
        remoteHead: HEAD.B,
        committedAt: "2026-10-16T09:00:00+00:00",
      },
      [BRANCH.D]: { localHead: HEAD.D, remoteHead: null, committedAt: "2026-10-16T09:05:00+00:00" },
    });
  });

  it("reads a github.com origin only", () => {
    expect(parseGitHubRemote("https://github.com/example/fixture.git\n")).toEqual({
      owner: "example",
      repo: "fixture",
    });
    expect(parseGitHubRemote("git@github.com:example/fixture.git")).toEqual({
      owner: "example",
      repo: "fixture",
    });
    expect(parseGitHubRemote("https://gitlab.com/example/fixture.git")).toBeNull();
  });

  it("consults no GitHub and reports no GitHub class for a workspace with no github.com origin", async () => {
    prState.B = { state: "closed", merged_at: null };
    setDeliveryCrossCheckDeps({
      readGit: async () => {
        const git: Record<string, { localHead: string; remoteHead: string; committedAt: string }> =
          {};
        for (const id of UNITS) {
          git[BRANCH[id]] = {
            localHead: HEAD[id],
            remoteHead: HEAD[id],
            committedAt: BEFORE_UPDATE,
          };
        }
        return git;
      },
      resolveGitHubRepository: async () => null,
      fetch: fakeFetch,
      watch: () => ({ close: () => undefined }),
    });
    const read = await readDeliveryCrossCheck(bench);
    expect(requests).toEqual([]);
    expect(read).toMatchObject({ disagreements: [], sourceError: null });
    expect(read.refreshedAt).not.toBeNull();
  });
});
