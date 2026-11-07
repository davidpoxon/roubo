// The loader of a Spec Bench's delivery cross-check (SB-FR-030, SB-NFR-003,
// SB-NFR-005, SB-US-010). It reads what the pure cross-check
// (`../lib/delivery-cross-check`) compares the record with, runs it, keeps the
// last list per bench for GET .../delivery/crosscheck, and raises the bench's
// `delivery-crosscheck` notification the first time a blocking class appears.
//
// Inputs of one refresh:
//   - the record in the bench workspace, folded with the accepted events above
//     its last_event_seq, and the spec's plan, results and lifecycle there;
//   - local git: one `git for-each-ref` of the local and `origin` branches;
//   - GitHub, when the workspace's `origin` is a github.com repository: at most
//     one GET /repos/{owner}/{repo}/stacks, sent with If-None-Match so an
//     unchanged resource answers 304 and the last body is used again, and one
//     pull-request query (GET /repos/{owner}/{repo}/pulls). No other GitHub
//     request is made, so a refresh costs at most two.
//
// When a refresh runs:
//   - load: the first read of the bench's cross-check since the server started
//     arms it and runs one refresh, which the read waits for;
//   - events: one refresh per accepted `unit.boundary`, `pr.submitted` or
//     `gate.reached` event of an armed bench;
//   - file changes: a change of the record or of test-results.json in the spec
//     folder of the workspace runs one refresh after a 500 ms debounce;
//   - backstop: 60 seconds after the last refresh of any kind, one refresh.
// File-change and backstop refreshes run at most once per 30 seconds: one that
// comes sooner is deferred to the end of the window, where it runs once for
// every change that came in it. Refreshes of one bench never overlap, and a
// trigger that comes while one waits to start joins it.
//
// A GitHub failure (a refused or failed request, or a body that does not read)
// keeps the disagreements GitHub settles (layer-order-differs,
// pr-state-differs, base-branch-differs) from the refresh before, and names
// GitHub in `sourceError`. The classes that git and the results settle are
// still read fresh. The next refresh that reads GitHub clears the error. A
// workspace with no github.com `origin` consults no GitHub and reports none of
// those classes.
//
// Notification: a refresh that finds a blocking class the refresh before did
// not find raises one `delivery-crosscheck` notification naming the class, keyed
// by it, so a repeat raises none. A refresh that no longer finds the class
// dismisses it, so a class cleared and found again raises a new one. A
// GitHub-settled class kept through a GitHub failure stays found. The bench
// records when the delivery first went blocking (`deliveryFirstSeenBlocking`)
// and the class it went blocking on (`deliveryFirstSeenBlockingClass`), and
// clears both once no blocking class is left.
import fs from "node:fs";
import type { Bench } from "@roubo/shared";
import {
  DELIVERY_RECORD_FILE,
  type DeliveryCrossCheckResponse,
  type DeliveryCrossCheckSourceError,
} from "@roubo/shared/delivery-bench";
import type { DeliveryEvent } from "@roubo/shared/delivery-observation-contract";
import { foldDelivery } from "@roubo/shared/delivery-reducer";
import {
  DELIVERY_CROSS_CHECK_CLASSES,
  crossCheckDelivery,
  type DeliveryCrossCheckEntry,
  type DeliveryGitObservation,
  type DeliveryPullRequest,
  type DeliveryPullRequestsObservation,
  type DeliveryStacksObservation,
} from "../lib/delivery-cross-check.js";
import {
  benchDeliveryEventSpillPath,
  deliverySpecFolder,
  loadBenchDeliveryRecord,
  loadBenchDeliveryVerifyInputs,
} from "../lib/delivery-record-loader.js";
import * as benchManager from "./bench-manager.js";
import * as credentialStore from "./credential-store.js";
import { deliveryEventsAfterRecord } from "./delivery-event-log.js";
import { runCommand } from "./exec.js";
import { GITHUB_PLUGIN_ID, GITHUB_TOKEN_SLOT } from "./github-oauth.js";
import { createNotification, dismissByKey } from "./notification.js";
import * as stateService from "./state.js";

export const DELIVERY_CROSS_CHECK_NOTIFICATION = "delivery-crosscheck";

// The event types that run a refresh of an armed bench.
export const DELIVERY_CROSS_CHECK_EVENT_TYPES: ReadonlySet<string> = new Set([
  "unit.boundary",
  "pr.submitted",
  "gate.reached",
]);

// The results file of the spec folder, beside the record.
export const DELIVERY_RESULTS_FILE = "test-results.json";

export const DELIVERY_CROSS_CHECK_DEBOUNCE_MS = 500;
export const DELIVERY_CROSS_CHECK_THROTTLE_MS = 30_000;
export const DELIVERY_CROSS_CHECK_BACKSTOP_MS = 60_000;

const GITHUB_API = "https://api.github.com";
const GITHUB_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 10_000;

// The classes whose source of truth is GitHub: the stacks resource and the
// pull request query.
const GITHUB_SOURCES: ReadonlySet<string> = new Set(["stack", "pull-request-api"]);

export type DeliveryCrossCheckTrigger = "load" | "event" | "file" | "backstop";

export interface GitHubRepository {
  owner: string;
  repo: string;
}

// The seams of the loader. Tests replace them; the defaults read git in the
// workspace, the GitHub token of the github-com plugin and the network.
export interface DeliveryCrossCheckDeps {
  readGit: (workspacePath: string) => Promise<DeliveryGitObservation>;
  resolveGitHubRepository: (workspacePath: string) => Promise<GitHubRepository | null>;
  githubToken: () => Promise<string | null>;
  fetch: typeof fetch;
  watch: (folder: string, onChange: (file: string) => void) => { close(): void };
  now: () => number;
}

interface CrossCheckEntryState {
  bench: Bench;
  disagreements: DeliveryCrossCheckEntry[];
  refreshedAt: string | null;
  sourceError: DeliveryCrossCheckSourceError | null;
  // The stacks resource's last ETag and the observation its body gave.
  stacksEtag: string | null;
  stacks: DeliveryStacksObservation;
  // The blocking classes the last refresh found; undefined before the first
  // refresh since the server started, which seeds it from the bench's
  // notifications so a restart raises none again.
  blockingSeen: Set<string> | undefined;
  runs: number;
  // When the last file-change or backstop refresh started, for the window.
  lastThrottledAt: number | null;
  tail: Promise<void>;
  queued: Promise<void> | null;
  loaded: Promise<void>;
  watcher: { close(): void } | null;
  debounceTimer: NodeJS.Timeout | null;
  throttleTimer: NodeJS.Timeout | null;
  backstopTimer: NodeJS.Timeout | null;
}

const entries = new Map<string, CrossCheckEntryState>();

function keyOf(projectId: string, benchId: number): string {
  return `${projectId}:${benchId}`;
}

// ── Default seams ──

// Every local branch and every branch of `origin`, with its head and commit
// time, in one git call. A branch with no key is missing.
async function defaultReadGit(workspacePath: string): Promise<DeliveryGitObservation> {
  const result = await runCommand(
    "git",
    [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)",
      "refs/heads",
      "refs/remotes/origin",
    ],
    workspacePath,
    undefined,
    GIT_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(`git for-each-ref failed in the bench workspace: ${result.stderr.trim()}`);
  }
  return parseForEachRef(result.stdout);
}

export function parseForEachRef(stdout: string): DeliveryGitObservation {
  const local = new Map<string, { head: string; committedAt: string }>();
  const remote = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const [ref, head, committedAt] = line.split("\t");
    if (ref === undefined || head === undefined || committedAt === undefined) continue;
    if (ref.startsWith("refs/heads/")) {
      local.set(ref.slice("refs/heads/".length), { head, committedAt });
    } else if (ref.startsWith("refs/remotes/origin/")) {
      const branch = ref.slice("refs/remotes/origin/".length);
      if (branch !== "HEAD") remote.set(branch, head);
    }
  }
  const observation: Record<string, DeliveryGitObservation[string]> = {};
  for (const [branch, { head, committedAt }] of local) {
    Object.defineProperty(observation, branch, {
      value: { localHead: head, remoteHead: remote.get(branch) ?? null, committedAt },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return observation;
}

const GITHUB_REMOTE_RE =
  /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export function parseGitHubRemote(url: string): GitHubRepository | null {
  const match = GITHUB_REMOTE_RE.exec(url.trim());
  if (match === null) return null;
  return { owner: match[1], repo: match[2] };
}

async function defaultResolveGitHubRepository(
  workspacePath: string,
): Promise<GitHubRepository | null> {
  const result = await runCommand(
    "git",
    ["remote", "get-url", "origin"],
    workspacePath,
    undefined,
    GIT_TIMEOUT_MS,
  );
  return result.code === 0 ? parseGitHubRemote(result.stdout) : null;
}

async function defaultGitHubToken(): Promise<string | null> {
  try {
    return await credentialStore.get(GITHUB_PLUGIN_ID, GITHUB_TOKEN_SLOT);
  } catch {
    return null;
  }
}

function defaultWatch(folder: string, onChange: (file: string) => void): { close(): void } {
  const watcher = fs.watch(folder, { persistent: false }, (_event, file) => {
    if (typeof file === "string") onChange(file);
  });
  // A watch error (the folder went with the workspace) ends the watch only.
  watcher.on("error", () => watcher.close());
  return watcher;
}

const defaultDeps: DeliveryCrossCheckDeps = {
  readGit: defaultReadGit,
  resolveGitHubRepository: defaultResolveGitHubRepository,
  githubToken: defaultGitHubToken,
  fetch: (input, init) => globalThis.fetch(input, init),
  watch: defaultWatch,
  now: () => Date.now(),
};

let deps: DeliveryCrossCheckDeps = defaultDeps;

// ── GitHub ──

class GitHubSourceError extends Error {}

function githubHeaders(token: string | null, etag?: string | null): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token !== null && token.length > 0 && { Authorization: `Bearer ${token}` }),
    ...(etag !== undefined && etag !== null && { "If-None-Match": etag }),
  };
}

async function githubGet(
  path: string,
  token: string | null,
  etag?: string | null,
): Promise<Response> {
  let res: Response;
  try {
    res = await deps.fetch(`${GITHUB_API}${path}`, {
      headers: githubHeaders(token, etag),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (err) {
    throw new GitHubSourceError(
      `GitHub could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return res;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// A stack's branches as the resource lists them: plain names, or objects that
// carry the name in `name`, `ref` or `branch`.
function branchNamesOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const item of value) {
    const name =
      stringOf(item) ??
      (typeof item === "object" && item !== null
        ? (stringOf((item as Record<string, unknown>).name) ??
          stringOf((item as Record<string, unknown>).ref) ??
          stringOf((item as Record<string, unknown>).branch))
        : undefined);
    if (name !== undefined) names.push(name);
  }
  return names;
}

// The stacks resource's body: a list of stacks, bare or under `stacks`, each
// with its `name` and its `branches` base first.
export function parseStacksBody(body: unknown): DeliveryStacksObservation {
  const list: unknown =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as { stacks?: unknown }).stacks
      : body;
  if (!Array.isArray(list)) {
    throw new GitHubSourceError("GitHub answered the stacks request with a body that is no list");
  }
  const stacks: Record<string, readonly string[]> = {};
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const name = stringOf((item as Record<string, unknown>).name);
    const branches = branchNamesOf((item as Record<string, unknown>).branches);
    if (name === undefined || branches === undefined) continue;
    Object.defineProperty(stacks, name, {
      value: branches,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return stacks;
}

// One pull-request query's body: each pull request by its head branch, the
// most recently updated first when a branch has more than one. A closed pull
// request that merged reads `merged`.
export function parsePullRequestsBody(body: unknown): DeliveryPullRequestsObservation {
  if (!Array.isArray(body)) {
    throw new GitHubSourceError(
      "GitHub answered the pull request query with a body that is no list",
    );
  }
  const pullRequests: Record<string, DeliveryPullRequest> = {};
  for (const item of body) {
    if (typeof item !== "object" || item === null) continue;
    const pr = item as Record<string, unknown>;
    const head = stringOf((pr.head as Record<string, unknown> | undefined)?.ref);
    const base = stringOf((pr.base as Record<string, unknown> | undefined)?.ref);
    const state = stringOf(pr.state);
    if (head === undefined || base === undefined || state === undefined) continue;
    if (Object.hasOwn(pullRequests, head)) continue;
    const merged = state.toLowerCase() === "closed" && stringOf(pr.merged_at) !== undefined;
    Object.defineProperty(pullRequests, head, {
      value: {
        state: merged ? "merged" : state,
        baseBranch: base,
        url: stringOf(pr.html_url) ?? "",
      },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return pullRequests;
}

async function readStacks(
  entry: CrossCheckEntryState,
  repository: GitHubRepository,
  token: string | null,
): Promise<DeliveryStacksObservation> {
  const res = await githubGet(
    `/repos/${repository.owner}/${repository.repo}/stacks`,
    token,
    entry.stacksEtag,
  );
  if (res.status === 304) return entry.stacks;
  if (res.status === 404) {
    // The repository has no stacks resource: nothing lists an order.
    entry.stacksEtag = null;
    entry.stacks = {};
    return entry.stacks;
  }
  if (!res.ok) {
    throw new GitHubSourceError(`GitHub answered the stacks request with ${res.status}`);
  }
  const body: unknown = await res.json().catch(() => {
    throw new GitHubSourceError("GitHub answered the stacks request with a body that is no JSON");
  });
  const stacks = parseStacksBody(body);
  entry.stacks = stacks;
  entry.stacksEtag = res.headers.get("etag");
  return stacks;
}

async function readPullRequests(
  repository: GitHubRepository,
  token: string | null,
): Promise<DeliveryPullRequestsObservation> {
  const res = await githubGet(
    `/repos/${repository.owner}/${repository.repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`,
    token,
  );
  if (!res.ok) {
    throw new GitHubSourceError(`GitHub answered the pull request query with ${res.status}`);
  }
  const body: unknown = await res.json().catch(() => {
    throw new GitHubSourceError(
      "GitHub answered the pull request query with a body that is no JSON",
    );
  });
  return parsePullRequestsBody(body);
}

// ── A refresh ──

const CLASS_ORDER = new Map<string, number>(
  DELIVERY_CROSS_CHECK_CLASSES.map((cls, index) => [cls, index]),
);

function byClass(list: DeliveryCrossCheckEntry[]): DeliveryCrossCheckEntry[] {
  // Array#sort is stable, so the order within a class is kept.
  return [...list].sort(
    (a, b) => (CLASS_ORDER.get(a.class) ?? 0) - (CLASS_ORDER.get(b.class) ?? 0),
  );
}

function isGitHubSettled(entry: DeliveryCrossCheckEntry): boolean {
  return GITHUB_SOURCES.has(entry.source);
}

function persist(bench: Bench): void {
  if (!benchManager.isBenchLive(bench.projectId, bench.id)) return;
  stateService.updateBench(stateService.toPersistedBench(bench));
}

function applyBlockingNotifications(
  state: CrossCheckEntryState,
  disagreements: readonly DeliveryCrossCheckEntry[],
  refreshedAt: string,
): void {
  const { bench } = state;
  const found: string[] = [];
  for (const entry of disagreements) {
    if (entry.blocking && !found.includes(entry.class)) found.push(entry.class);
  }
  const seen =
    state.blockingSeen ??
    new Set(
      bench.notifications
        .filter((n) => n.type === DELIVERY_CROSS_CHECK_NOTIFICATION && n.dedupeKey !== undefined)
        .map((n) => n.dedupeKey as string),
    );
  for (const cls of found) {
    if (seen.has(cls)) continue;
    const count = disagreements.filter((entry) => entry.class === cls).length;
    createNotification(
      bench,
      DELIVERY_CROSS_CHECK_NOTIFICATION,
      undefined,
      { class: cls, count },
      undefined,
      undefined,
      cls,
    );
  }
  for (const cls of seen) {
    if (!found.includes(cls)) dismissByKey(bench, DELIVERY_CROSS_CHECK_NOTIFICATION, cls);
  }
  state.blockingSeen = new Set(found);

  if (found.length > 0 && bench.deliveryFirstSeenBlocking === undefined) {
    bench.deliveryFirstSeenBlocking = refreshedAt;
    bench.deliveryFirstSeenBlockingClass = found[0];
    persist(bench);
  } else if (found.length === 0 && bench.deliveryFirstSeenBlocking !== undefined) {
    bench.deliveryFirstSeenBlocking = undefined;
    bench.deliveryFirstSeenBlockingClass = undefined;
    persist(bench);
  }
}

async function refresh(state: CrossCheckEntryState): Promise<void> {
  const { bench } = state;
  state.runs += 1;
  // The two paths only, so the read prunes no control queue and moves no mode:
  // the routes that serve the record do that.
  const paths = { workspacePath: bench.workspacePath, focusedSpecPath: bench.focusedSpecPath };
  const loaded = loadBenchDeliveryRecord(paths);
  if (!loaded.ok) return;
  const events: DeliveryEvent[] = deliveryEventsAfterRecord(
    bench.projectId,
    bench.id,
    loaded.record,
    benchDeliveryEventSpillPath(paths),
  );
  const verify = loadBenchDeliveryVerifyInputs(paths);
  const snapshot = foldDelivery({ record: loaded.record, events, ...verify });
  const git = await deps.readGit(bench.workspacePath);

  let stacks: DeliveryStacksObservation = {};
  let pullRequests: DeliveryPullRequestsObservation = {};
  let sourceError: DeliveryCrossCheckSourceError | null = null;
  const repository = await deps.resolveGitHubRepository(bench.workspacePath);
  if (repository !== null) {
    try {
      const token = await deps.githubToken();
      stacks = await readStacks(state, repository, token);
      pullRequests = await readPullRequests(repository, token);
    } catch (err) {
      sourceError = {
        source: "github",
        message:
          err instanceof GitHubSourceError
            ? err.message
            : `GitHub could not be read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const fresh = crossCheckDelivery(snapshot, git, stacks, pullRequests, verify.results, {
    ...(verify.plan !== undefined && { plan: verify.plan }),
    ...(verify.lifecycle !== undefined && { lifecycle: verify.lifecycle }),
  });
  let disagreements: DeliveryCrossCheckEntry[];
  if (repository === null) {
    disagreements = fresh.filter((entry) => !isGitHubSettled(entry));
  } else if (sourceError !== null) {
    disagreements = byClass([
      ...fresh.filter((entry) => !isGitHubSettled(entry)),
      ...state.disagreements.filter(isGitHubSettled),
    ]);
  } else {
    disagreements = fresh;
  }

  const refreshedAt = new Date(deps.now()).toISOString();
  state.disagreements = disagreements;
  state.sourceError = sourceError;
  state.refreshedAt = refreshedAt;
  applyBlockingNotifications(state, disagreements, refreshedAt);
}

// ── Scheduling ──

function clearTimer(timer: NodeJS.Timeout | null): null {
  if (timer !== null) clearTimeout(timer);
  return null;
}

function armBackstop(state: CrossCheckEntryState): void {
  state.backstopTimer = clearTimer(state.backstopTimer);
  const timer = setTimeout(() => {
    state.backstopTimer = null;
    void requestThrottled(state, "backstop");
  }, DELIVERY_CROSS_CHECK_BACKSTOP_MS);
  timer.unref();
  state.backstopTimer = timer;
}

function requestRun(
  state: CrossCheckEntryState,
  trigger: DeliveryCrossCheckTrigger,
): Promise<void> {
  if (state.queued !== null) return state.queued;
  const queued = state.tail.then(async () => {
    state.queued = null;
    if (!isTracked(state)) return;
    if (trigger === "file" || trigger === "backstop") state.lastThrottledAt = deps.now();
    try {
      await refresh(state);
    } catch (err) {
      console.warn(
        `[delivery-crosscheck] bench ${state.bench.projectId}/${state.bench.id}: the ${trigger} refresh failed:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      if (isTracked(state)) armBackstop(state);
    }
  });
  state.queued = queued;
  state.tail = queued;
  return queued;
}

// A file-change or backstop refresh: now when the last one is 30 seconds or
// more behind, else once at the end of its window.
function requestThrottled(
  state: CrossCheckEntryState,
  trigger: "file" | "backstop",
): Promise<void> | undefined {
  const last = state.lastThrottledAt;
  const wait = last === null ? 0 : last + DELIVERY_CROSS_CHECK_THROTTLE_MS - deps.now();
  if (wait <= 0) return requestRun(state, trigger);
  if (state.throttleTimer === null) {
    const timer = setTimeout(() => {
      state.throttleTimer = null;
      void requestRun(state, trigger);
    }, wait);
    timer.unref();
    state.throttleTimer = timer;
  }
  return undefined;
}

function onFileChange(state: CrossCheckEntryState, file: string): void {
  if (file !== DELIVERY_RECORD_FILE && file !== DELIVERY_RESULTS_FILE) return;
  state.debounceTimer = clearTimer(state.debounceTimer);
  const timer = setTimeout(() => {
    state.debounceTimer = null;
    void requestThrottled(state, "file");
  }, DELIVERY_CROSS_CHECK_DEBOUNCE_MS);
  timer.unref();
  state.debounceTimer = timer;
}

function isTracked(state: CrossCheckEntryState): boolean {
  return entries.get(keyOf(state.bench.projectId, state.bench.id)) === state;
}

// Arms the bench's cross-check once: the file watch, and the load refresh.
function armed(bench: Bench): CrossCheckEntryState {
  const key = keyOf(bench.projectId, bench.id);
  const existing = entries.get(key);
  if (existing !== undefined) {
    existing.bench = bench;
    return existing;
  }
  const state: CrossCheckEntryState = {
    bench,
    disagreements: [],
    refreshedAt: null,
    sourceError: null,
    stacksEtag: null,
    stacks: {},
    blockingSeen: undefined,
    runs: 0,
    lastThrottledAt: null,
    tail: Promise.resolve(),
    queued: null,
    loaded: Promise.resolve(),
    watcher: null,
    debounceTimer: null,
    throttleTimer: null,
    backstopTimer: null,
  };
  entries.set(key, state);
  try {
    state.watcher = deps.watch(deliverySpecFolder(bench), (file) => onFileChange(state, file));
  } catch {
    // No spec folder to watch yet (or an unsafe one): the backstop and the
    // events still refresh.
    state.watcher = null;
  }
  state.loaded = requestRun(state, "load");
  return state;
}

function responseOf(state: CrossCheckEntryState): DeliveryCrossCheckResponse {
  return {
    disagreements: state.disagreements,
    refreshedAt: state.refreshedAt,
    sourceError: state.sourceError,
  };
}

// ── Entry points ──

/**
 * The bench's last cross-check. The first read since the server started arms
 * the bench and waits for its load refresh.
 */
export async function readDeliveryCrossCheck(bench: Bench): Promise<DeliveryCrossCheckResponse> {
  const state = armed(bench);
  await state.loaded;
  return responseOf(state);
}

/**
 * Runs one refresh per accepted event of a refreshing type, on an armed bench.
 * Resolves when those refreshes ran.
 */
export function refreshDeliveryCrossCheckOnEvents(
  bench: Bench,
  events: readonly DeliveryEvent[],
): Promise<void> {
  const state = entries.get(keyOf(bench.projectId, bench.id));
  if (state === undefined) return Promise.resolve();
  state.bench = bench;
  const runs: Promise<void>[] = [];
  for (const event of events) {
    if (DELIVERY_CROSS_CHECK_EVENT_TYPES.has(event.type)) runs.push(requestRun(state, "event"));
  }
  return Promise.all(runs).then(() => undefined);
}

/** Resolves once no refresh of the bench waits or runs. */
export async function whenDeliveryCrossCheckIdle(
  projectId: string,
  benchId: number,
): Promise<void> {
  const state = entries.get(keyOf(projectId, benchId));
  if (state === undefined) return;
  let tail: Promise<void>;
  do {
    tail = state.tail;
    await tail;
  } while (tail !== state.tail);
}

/** How many refreshes the bench ran since it was armed; 0 when it is not. */
export function deliveryCrossCheckRunCount(projectId: string, benchId: number): number {
  return entries.get(keyOf(projectId, benchId))?.runs ?? 0;
}

/**
 * Disarms one bench (on Clear bench) or every bench: its watch and timers stop,
 * and its last list goes.
 */
export function forgetDeliveryCrossCheck(projectId?: string, benchId?: number): void {
  for (const [key, state] of entries) {
    if (projectId !== undefined && benchId !== undefined && key !== keyOf(projectId, benchId)) {
      continue;
    }
    state.watcher?.close();
    clearTimer(state.debounceTimer);
    clearTimer(state.throttleTimer);
    clearTimer(state.backstopTimer);
    entries.delete(key);
  }
}

/** Replaces the loader's seams; with no argument, restores the defaults. */
export function setDeliveryCrossCheckDeps(overrides?: Partial<DeliveryCrossCheckDeps>): void {
  deps = overrides === undefined ? defaultDeps : { ...defaultDeps, ...overrides };
}
