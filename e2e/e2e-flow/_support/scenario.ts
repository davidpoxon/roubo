import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import type { AssignedIssue, MarketplaceCatalogEntry, PluginRecord } from "@roubo/shared";

// TC-153: shape of one entry in the ROUBO_E2E=1-only tap exposed by
// `GET /test/__connection-state-log`. The tap mirrors the structured log
// lines emitted by `recordConnectionStateTransition` in
// server/services/plugin-manager.ts; keep this type in lock-step with the
// exported `ConnectionStateLogEntry` there.
export interface ConnectionStateLogEntry {
  event: "plugin.connection-state.changed";
  pluginId: string;
  previousState: string | null;
  newState: string;
  trigger: string;
  at: string;
}

/**
 * Reset server singletons and pin the stubbed plugin to a scenario + frozen
 * clock for the duration of a single spec (WU-063). All e2e-flow specs go
 * through this helper so that the calling shape is uniform and the assertion
 * about the 200 response is centralised.
 *
 * WU-066 (TC-171/TC-172): pass `{ bundledPluginsDisabled: true }` to land the
 * spec in a greenfield-like state (bundled plugin ids written as "disabled"
 * in plugins-state.json) so the project-load Enable-plugin prompt fires. The
 * default preserves the WU-068 behaviour of force-enabling bundled plugins.
 */
export async function resetWithScenario(
  request: APIRequestContext,
  scenario: string,
  now: string,
  opts: { bundledPluginsDisabled?: boolean } = {},
): Promise<void> {
  const data: Record<string, unknown> = { scenario, now };
  if (opts.bundledPluginsDisabled) {
    data.bundledPluginsDisabled = true;
  }
  const res = await request.post("/test/__reset", { data });
  expect(res.status()).toBe(200);
}

/**
 * #574 (TC-047): stamp the only-to-do default-change notice marker (FR-018,
 * issue #558) with a fixed ISO timestamp via the ROUBO_E2E-gated
 * `POST /test/__seed-notice`. `/test/__reset` truncates state.json (so the
 * marker is absent) and the boot seed only ever writes the never-surfaced
 * `"seeded"` sentinel on a fresh install, so this is the only way to drive the
 * "existing install, banner should show once" state the upgrade-banner journey
 * needs. Returns the stamped timestamp so the spec can key its localStorage
 * assertions on the same value the banner uses for dismissal.
 */
export async function seedOnlyToDoNotice(request: APIRequestContext, at?: string): Promise<string> {
  const res = await request.post("/test/__seed-notice", {
    data: at === undefined ? {} : { at },
  });
  expect(res.status(), "seed only-to-do notice marker").toBe(200);
  const body = (await res.json()) as { marker: string; at: string };
  return body.at;
}

/**
 * Fetch the stubbed plugin's live connection-status and assert both the
 * scenario-derived `detail` and the pinned `checkedAt`. This is the
 * end-to-end proof that the spec's --scenario / --now reached the spawned
 * plugin process and the response made it back through the host RPC layer.
 */
export async function expectStubConnectionStatus(
  request: APIRequestContext,
  expected: { detail: string; checkedAt: string },
): Promise<void> {
  const res = await request.get("/api/plugins/e2e-stub/connection-status");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { state: string; detail?: string; checkedAt?: string };
  expect(body.state).toBe("connected");
  expect(body.detail).toBe(expected.detail);
  expect(body.checkedAt).toBe(expected.checkedAt);
}

/**
 * Load the built client shell and confirm it returned a 200 with the React
 * root element present. Used by every e2e-flow spec to keep a real browser
 * navigation in the loop alongside the API-level scenario assertions.
 */
export async function loadAppShell(page: Page): Promise<void> {
  const res = await page.goto("/");
  expect(res?.status()).toBe(200);
  await expect(page.locator("#root")).toBeAttached();
}

/**
 * Switch the open TestBench panel to the whole-spec "Cases" review.
 *
 * The view toggle defaults to the verify-gate "Batches" surface on a bench's
 * first visit (#359), but these journeys assert on the Cases review (the
 * Overall rollup, the case list, recorded results). Press "Cases" so those
 * assertions see the right surface. The choice is remembered per bench (#359),
 * so this holds across later tab navigation and reloads within the same bench;
 * the helper is idempotent (a no-op when Cases is already active). Call it after
 * the TestBench tab is open and its panel is rendered.
 */
export async function showTestBenchCasesView(page: Page): Promise<void> {
  const cases = page.getByRole("tabpanel").getByRole("button", { name: "Cases", exact: true });
  if ((await cases.getAttribute("aria-pressed")) !== "true") {
    await cases.click();
  }
  await expect(cases, "TestBench Cases view is active").toHaveAttribute("aria-pressed", "true");
}

/**
 * Assert that, inside `scope`, the `ConnectionStatusPill` is visible and is
 * carrying the expected `data-state` value. WU-064 (TC-168/TC-169): the pill
 * is the testable surface for connection-status placement assertions; callers
 * pass a Locator that scopes the query to one of the three placements
 * (PluginCard, Configure modal header, project Issue Source tile).
 */
export async function expectConnectionStatePillState(
  scope: Locator,
  expectedState: string,
): Promise<void> {
  const pill = scope.getByTestId("connection-status-pill");
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("data-state", expectedState);
}

/**
 * #568 (CLI-TC-017): un-bypass the persistent cut-list disk snapshot for the
 * duration of one spec via the ROUBO_E2E-gated `/test/__set-cut-list-disk-cache`
 * endpoint. The harness bypasses the disk path by default (so a snapshot from
 * one scenario is never served to a later one, NFR-018), which makes the
 * warm-snapshot serve unreachable. The cut-list-refresh drift guard needs that
 * warm path: it enables the disk cache after the per-spec reset, drives a first
 * open (miss -> snapshot written) then a reload (warm serve), and `/test/__reset`
 * restores the default for the next spec. Pass `enabled: false` to re-bypass.
 */
export async function setCutListDiskCacheEnabled(
  request: APIRequestContext,
  enabled: boolean,
): Promise<void> {
  const res = await request.post("/test/__set-cut-list-disk-cache", { data: { enabled } });
  expect(res.status(), "toggle cut-list disk cache").toBe(200);
}

/**
 * #314 (CPHM-TC-051): flip the marketplace catalog client between reachable
 * (network source) and unreachable (degrade to cache/seed) for the duration of
 * one offline-journey step, via the ROUBO_E2E-gated
 * `/test/__set-marketplace-reachable` endpoint. The toggle busts the catalog
 * memo so the served source flips on the next read, and the response carries the
 * freshly resolved source so the spec can assert the degrade/reconnect at the
 * catalog-client boundary. `/test/__reset` restores reachable:true so the toggle
 * never leaks into a later spec (NFR-018). Returns the resolved catalog source
 * ("network" | "cache" | "seed").
 */
export async function setMarketplaceReachable(
  request: APIRequestContext,
  reachable: boolean,
): Promise<string> {
  const res = await request.post("/test/__set-marketplace-reachable", { data: { reachable } });
  expect(res.status(), `toggle marketplace reachable=${reachable}`).toBe(200);
  const body = (await res.json()) as { source: string };
  return body.source;
}

/**
 * #575 (CPHMTP-TC-073): seed a registered third-party source's per-source catalog
 * CACHE via the ROUBO_E2E-gated `/test/__seed-source-catalog` endpoint, so the
 * source deterministically serves the given entries with NO real network.
 * Registering a source is a pure write (CPHMTP-NFR-003) and the declared ACME URL
 * (ghe.acme.internal) is unreachable under the harness, so the source's
 * NETWORK -> CACHE degrade chain would otherwise bottom out empty. This seeds the
 * cache the chain degrades to and drops any memoised client, so the missing-plugin
 * bench-start resolution names the source (registered). `/test/__reset` clears the
 * sources + per-source caches so nothing leaks into a later spec (NFR-018).
 */
export async function seedSourceCatalog(
  request: APIRequestContext,
  opts: { sourceId: string; entries: MarketplaceCatalogEntry[]; fetchedAt?: string },
): Promise<void> {
  const res = await request.post("/test/__seed-source-catalog", {
    data: {
      sourceId: opts.sourceId,
      entries: opts.entries,
      ...(opts.fetchedAt === undefined ? {} : { fetchedAt: opts.fetchedAt }),
    },
  });
  expect(res.status(), `seed source catalog for ${opts.sourceId}`).toBe(200);
}

// #313 (CPHM-TC-041): one installed seed plugin's on-disk shape, as reported by
// `POST /test/__seed-fresh-launch`. Keep in lock-step with `SeedPluginSnapshot`
// in server/routes/test.ts.
export interface SeedPluginSnapshot {
  id: string;
  manifestId: string | null;
  hasEntry: boolean;
}

// #313 (CPHM-TC-041): the parsed idempotency marker (.seed-version.json). Keep
// in lock-step with `SeedMarkerSnapshot` in server/routes/test.ts.
export interface SeedMarkerSnapshot {
  present: boolean;
  seedVersion: number | null;
  seededIds: string[];
  seededAt: string | null;
}

// #313 (CPHM-TC-041): the result of one genuine offline first-run seed pass.
export interface FreshLaunchResult {
  // The seed set the host targets (pluginManager.SEED_PLUGIN_IDS).
  seedSet: string[];
  // True when this pass actually seeded (a genuine first launch); false when the
  // marker short-circuited it (an idempotent relaunch).
  seededNow: boolean;
  installed: SeedPluginSnapshot[];
  marker: SeedMarkerSnapshot;
}

/**
 * #313 (CPHM-TC-041): drive a GENUINE offline first-run seed via the
 * ROUBO_E2E-gated `POST /test/__seed-fresh-launch` seam and return the result.
 * The seam synthesises a throwaway seed bundle, runs `seedFromBundled()` into an
 * isolated tmp user root, and reports the installed plugins + idempotency marker
 * without touching the live plugin-manager (NFR-018). Pass `{ relaunch: true }`
 * to re-run the seed against the SAME sandbox from the prior fresh launch, which
 * proves the marker makes a relaunch a no-op. `/test/__reset` tears the sandbox
 * down so it never leaks into a later spec.
 */
export async function seedFreshLaunch(
  request: APIRequestContext,
  opts: { relaunch?: boolean } = {},
): Promise<FreshLaunchResult> {
  const res = await request.post("/test/__seed-fresh-launch", {
    data: opts.relaunch ? { relaunch: true } : {},
  });
  expect(res.status(), `seed fresh launch (relaunch=${opts.relaunch ?? false})`).toBe(200);
  return (await res.json()) as FreshLaunchResult;
}

/**
 * Register a throwaway project for the duration of one spec, pinned to the
 * requested plugin via an integration override. The fixture is torn down by
 * the next `/test/__reset` call (see #232), so specs that need a registered
 * project can compose this with `resetWithScenario` in `beforeEach`. The
 * returned `projectId` is suitable for `page.goto(`/projects/${id}/settings`)`.
 */
export async function registerFixtureProject(
  request: APIRequestContext,
  opts: {
    projectId: string;
    // TC-164: omit `plugin` to register a fixture project with no integration
    // override so the IssueSourceTile renders its UnconfiguredBody variant.
    plugin?: string;
    // WU-068: optional extra integration fields (instance, sources,
    // capturedUserId, etc.) merged into the saved override alongside
    // `plugin`. Specs use this to drive surfaces (e.g. Source-tile instance
    // line) that only render when the override carries the matching value.
    integrationConfig?: Record<string, unknown>;
    // TC-164/167/177: optional `project.repo` written into the fixture
    // roubo.yaml so the github-com Configure modal's derived-sources preview
    // resolves to a success state (the server derives sources from
    // `config.project.repo`).
    projectRepo?: string;
    // CLI-TC-062 (#573): optional port base written into the fixture
    // roubo.yaml. A spec that registers two fixture projects at once must give
    // each a distinct base, since the port allocator rejects overlapping
    // ranges. Defaults to the route's high base when omitted.
    portBase?: number;
    // TC-161: optional list of benches to seed against the fixture project,
    // each pinned with its own `assignedIssue`. The server route persists
    // them onto fresh tmpdir-backed PersistedBench rows and reloads
    // bench-manager so subsequent GET /api/projects/:id/benches surfaces
    // them. Use this when a spec needs benches that pre-date a later
    // mutation (e.g. an integration switch) without paying the cost of the
    // real bench-provisioning flow.
    seedBenches?: Array<{ assignedIssue: AssignedIssue }>;
    // TC-001 (#438): optional specs to seed into the fixture repo as
    // `.specifications/<slug>/test-cases.json`, so TestBench spec discovery and
    // the create flow run against real files. Each `testCases` value is written
    // verbatim as the spec's plan JSON.
    // TSPF-TC-010 (#486): an entry may also carry `seedResults` to emit a
    // hash-matching `test-results.json` sidecar synthesized from its plan, so the
    // spec lands in a known verification classification ("all-passed" behind the
    // picker disclosure, or "partial" needs-attention with a real pass-state
    // summary). Omitted => no sidecar (needs-attention, "no results yet").
    seedSpecs?: Array<{ slug: string; testCases: unknown; seedResults?: "all-passed" | "partial" }>;
    // TC-001 (#438): when true, the server `git init`s + commits the fixture
    // repo and pins its worktree source to the local HEAD, so a real TestBench
    // worktree can be provisioned without an `origin` remote.
    gitInit?: boolean;
    // TC-032 (#708): when true, the fixture roubo.yaml sets
    // `benches.enforceIssueDependencies: true`, turning the host's hard
    // start-gate ON at the project level (no reliance on the global default).
    // The start-gate e2e drives the blocked -> allowed journey against it.
    enforceIssueDependencies?: boolean;
    // CP-TC-028 (#626): optional id of a component plugin to bind a `deploy`
    // component to in the fixture roubo.yaml (alongside the default `app`
    // process component). The route writes both bindings, so a spec can model
    // an existing roubo.yaml that binds process + a second component plugin
    // (e.g. CPHM-TC-061 binding process + database).
    componentPlugin?: string;
    // CPHMTP-TC-073 (#575): optional third-party marketplace URLs written into
    // the fixture roubo.yaml `marketplaces:` block, so the project-open flow has
    // a declared-but-unregistered source to offer registering.
    declaredMarketplaces?: string[];
    // CPHMTP-TC-073 (#575): optional binding of an arbitrary named component to
    // an arbitrary (possibly uninstalled) plugin id, e.g. an `apps-script`
    // component bound to `google-clasp`. Drives the missing-plugin bench-start
    // resolution for a plugin served only by a declared marketplace.
    componentBinding?: { name: string; pluginId: string };
  },
): Promise<{ projectId: string; repoPath: string }> {
  const res = await request.post("/test/__register-fixture-project", { data: opts });
  expect(res.status()).toBe(200);
  return (await res.json()) as { projectId: string; repoPath: string };
}

/**
 * Read the ROUBO_E2E=1-only tap exposed by `GET /test/__connection-state-log`.
 * The tap mirrors the structured log lines emitted by
 * `recordConnectionStateTransition` (TC-153 / NFR-023). TC-169 uses it to
 * assert that an opportunistic recheck observed a state transition without
 * scraping the running server's stdout.
 */
export async function fetchConnectionStateLog(
  request: APIRequestContext,
): Promise<ConnectionStateLogEntry[]> {
  const res = await request.get("/test/__connection-state-log");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { entries: ConnectionStateLogEntry[] };
  return body.entries;
}

/**
 * TC-043 (#440): overwrite a provisioned TestBench's focused test-cases.json via
 * the ROUBO_E2E-gated `/test/__rewrite-spec-cases` endpoint. The create-a-
 * TestBench UI does not expose a plan editor, so the persist -> staleness ->
 * reconcile spec drives the mid-test plan edit (remove a case, add a case)
 * through this harness write. As of #493 the server resolves the spec directory
 * from the bench's own worktree (the same path the live TestBench routes
 * read/write), so the next plan load detects staleness against the rewritten
 * source.
 */
export async function rewriteSpecTestCases(
  request: APIRequestContext,
  opts: { projectId: string; benchId: number; testCases: unknown },
): Promise<void> {
  const res = await request.post("/test/__rewrite-spec-cases", { data: opts });
  expect(res.status()).toBe(200);
}

/**
 * #487 (TSPF-TC-011): seed a plan-hash-matching test-results.json sidecar for a
 * discovered spec in a fixture project's repo via the ROUBO_E2E-gated
 * `POST /test/__seed-spec-results`, so the spec picker's server-side
 * classification sorts it into the partition's "all-passed" group. Only the plan
 * is written by `registerFixtureProject`'s `seedSpecs`; no other seam writes a
 * results sidecar, so this is the sole way to drive a spec to the all-passed
 * classification the partitioned picker relies on. Omit `passCaseIds` to mark
 * every case passed (a fully all-passed spec); pass a subset to leave the spec
 * needs-attention with a "P of M passed" summary. The sidecar is written to the
 * registered project repoPath (where discovery reads), not a bench worktree.
 */
export async function seedSpecResults(
  request: APIRequestContext,
  opts: { projectId: string; slug: string; passCaseIds?: string[] },
): Promise<void> {
  const res = await request.post("/test/__seed-spec-results", { data: opts });
  expect(res.status(), `seed spec results for ${opts.slug}`).toBe(200);
}

/**
 * TC-043 (#440): read a provisioned TestBench's on-disk test-results.json sidecar
 * (plus the source test-cases.json sha256) via `/test/__read-spec-results`. The
 * spec uses this to assert the NFR-003 integrity invariant directly against disk:
 * the flattened results (#493) retain the archived (orphaned) case after
 * reconcile, and the source plan's checksum is unchanged (reconcile never
 * rewrites the source plan).
 */
export async function readTestResults(
  request: APIRequestContext,
  opts: { projectId: string; benchId: number },
): Promise<{ results: unknown; casesChecksum: string }> {
  const res = await request.get(
    `/test/__read-spec-results?projectId=${encodeURIComponent(
      opts.projectId,
    )}&benchId=${opts.benchId}`,
  );
  expect(res.status()).toBe(200);
  return (await res.json()) as { results: unknown; casesChecksum: string };
}

/**
 * #567 (CLI-TC-001): read the persisted cut-list first-page snapshot file for a
 * project via the ROUBO_E2E-gated `/test/__read-cut-list-cache-file`. The
 * warm-restart drift guard uses this to assert the on-disk file's S003
 * invariants directly against disk: the file mode is exactly 0600 (CLI-NFR-001)
 * and the parsed JSON content carries no credential or token fields. Modelled on
 * `readTestResults`. Returns the file path, its numeric mode (permission bits
 * only, masked to 0o777), and the parsed JSON content.
 */
export async function readCutListCacheFile(
  request: APIRequestContext,
  opts: { projectId: string },
): Promise<{ path: string; mode: number; content: unknown }> {
  const res = await request.get(
    `/test/__read-cut-list-cache-file?projectId=${encodeURIComponent(opts.projectId)}`,
  );
  expect(res.status(), "read cut-list cache file").toBe(200);
  return (await res.json()) as { path: string; mode: number; content: unknown };
}

/**
 * Fetch a single plugin's record by id from `GET /api/plugins`. The endpoint
 * returns the full installed list; TC-163 (#240) keeps the helper focused so
 * specs don't repeat the find-by-id boilerplate.
 */
export async function fetchPluginRecord(
  request: APIRequestContext,
  pluginId: string,
): Promise<PluginRecord | undefined> {
  const res = await request.get("/api/plugins");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { plugins: PluginRecord[] };
  return body.plugins.find((p) => p.id === pluginId);
}

/**
 * TC-163 (#240): SIGKILL the named plugin's live child via the
 * `/test/__crash-plugin` ROUBO_E2E-gated endpoint so the supervisor sees an
 * unexpected exit. The endpoint returns 409 when the plugin is not running;
 * callers should `waitForPluginRestart` before chaining additional crashes.
 */
export async function crashStubPlugin(request: APIRequestContext, pluginId: string): Promise<void> {
  const res = await request.post("/test/__crash-plugin", { data: { pluginId } });
  expect(res.status()).toBe(200);
}

/**
 * TC-163 (#240): poll `GET /api/plugins` until the named plugin's record
 * matches the supplied predicate. Used to observe restart-budget transitions
 * (history grew, respawned with a new pid, transitioned to errored) without
 * tying the spec to backoff timing. Total timeout matches the
 * `BACKOFF_SCHEDULE_MS` ceiling (500ms + 1000ms + 2000ms ≈ 3.5s) with
 * generous headroom for CI variance.
 */
export async function waitForPluginRecord(
  request: APIRequestContext,
  pluginId: string,
  predicate: (record: PluginRecord) => boolean,
  opts: { timeoutMs?: number } = {},
): Promise<PluginRecord> {
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const deadline = Date.now() + timeoutMs;
  let last: PluginRecord | undefined;
  while (Date.now() < deadline) {
    last = await fetchPluginRecord(request, pluginId);
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `waitForPluginRecord(${pluginId}) timed out after ${timeoutMs}ms; last record: ${JSON.stringify(last)}`,
  );
}

/**
 * Read the persisted plugin-enable-state file via the e2e harness endpoint.
 * TC-154 (#222) asserts the NFR-024 invariant ("plugin remains in its
 * previous disabled state on spawn failure") by snapshotting this map before
 * and after the Enable click; the snapshot lets the spec verify that the
 * on-disk file was not mutated, without poking the filesystem from the
 * test process.
 */
export async function fetchPluginEnableState(
  request: APIRequestContext,
): Promise<Record<string, "enabled" | "disabled">> {
  const res = await request.get("/test/__plugin-enable-state");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { plugins: Record<string, "enabled" | "disabled"> };
  return body.plugins;
}
