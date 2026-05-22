# Feasibility: Global maximum on initialised Benches

> Slug: `global-bench-limit` · Investigated: 2026-05-22

## Recommendation

build — every piece this feature needs already has a clear precedent in the codebase (settings round-trip, per-Project cap enforcement, single-threaded in-memory Bench reservation, React Aria disabled-Button + Tooltip), and the one novel concern (cross-Project counting with strict first-write-wins) collapses to "read the in-memory `benches` Map under Node's single-threaded event loop before any `await`," which is exactly the pattern `createBench` already uses for per-Project reservation.

## Prior art

- **`createBench` reservation pattern** — `server/services/bench-manager.ts:404-459` · Already enforces a per-Project cap (`config.benches.max`) using a synchronous `findNextBenchNumber` → `benches.set(...)` with an explicit comment ("No `await` between findNextBenchNumber and benches.set"). The global cap check should slot directly into this same pre-`await` block so it shares the same atomicity guarantee. No new locking primitive is required at the in-memory layer.
- **`getBenches(projectId?)` cross-Project query** — `server/services/bench-manager.ts:1588-1594` · Already returns all Benches across all Projects when called with no argument. Counting initialised Benches globally is `benchManager.getBenches().length`. Includes Benches currently in `status: "preparing"`, which is exactly the in-flight-counts-as-taken behaviour the context demands.
- **`UserPreferences` round-trip** — `shared/types.ts:929-935`, `server/services/state.ts:183-217`, `server/routes/settings.ts:31-123` · `BenchSettings` already exists on `UserPreferences` with default-merge on read and a typed PUT validator. The new `maxBenchesGlobal` field can extend `BenchSettings` (or sit alongside it on `UserPreferences`) with the same pattern: optional field, default-merge in `loadSettings`, validate in the PUT handler.
- **Settings UI tab** — `client/src/components/ProjectSettings.tsx:133-194` (`BenchesTab`) and `:712-715` (`TAB_LABELS`) · `BenchesTab` already uses `useSettings()` + `updateSettings()` with a `Partial<BenchSettings>` patch helper. The new control attaches as a section inside this tab. Renaming the label is a one-line change in `TAB_LABELS`.
- **`useSettings` hook + typed `SettingsResponse`** — `shared/types.ts:937-941` + `useSettings()` consumed in `BenchesTab` · Client-side total-count awareness for the disabled-state UX can read `settings.maxBenchesGlobal` and `useAllBenches()` data, both already in cache.
- **`useAllBenches`** — `client/src/hooks/useBenches.ts:8-14` · Already exposes the cross-Project list via React Query with a 5s refetch (1s during active operations). The "New bench" Button's `isDisabled` derivation reads from this and `useSettings()`; no new endpoint or fan-out is needed.
- **`ProjectTile` per-Project meter** — `client/src/components/ProjectTile.tsx:13-72` · Existing precedent for "X / Y benches" rendering with a progress bar. The same shape can render the global cap state in the dashboard header or as a banner.
- **`CreateBenchModal` confirm Button** — `client/src/components/CreateBenchModal.tsx:120-127` · Already a React Aria `Button` with `isDisabled` and an error-message rendering. Wiring the global-cap disabled state and accessible tooltip is a localized change.
- **`auto-clear.ts` (confirms "no auto-create")** — `server/services/auto-clear.ts` · Only invokes `benchManager.teardownBench`; never calls `createBench`. Searching the full server for `benchManager.createBench` confirms only two call sites: `server/routes/benches.ts:88` (POST) and `server/services/issue-assignment.ts:177` (user-initiated assign-to-Bench flow). The "cap only governs user-initiated creates" claim in the context holds today, and both call sites correctly funnel through `createBench`, so a single enforcement point in `createBench` covers all current callers.
- **`BenchError`-driven HTTP mapping** — `server/services/bench-manager.ts:1804-1812` + `server/routes/benches.ts:91-93` · The route already maps `NO_BENCHES` to 409. A new code like `GLOBAL_CAP_REACHED` mapped to 409 mirrors that pattern exactly.

## Capability gaps

- **`maxBenchesGlobal` field on `UserPreferences`** — Not present today. · Candidate: add `maxBenchesGlobal?: number` to either `BenchSettings` or `UserPreferences` directly. Context ties this to `~/.roubo/settings.json` (the same file as `theme`), so putting it on `UserPreferences` rather than the nested `benches` block matches the seed phrasing literally; placing it on `BenchSettings` keeps Bench-related preferences grouped. Either is mechanically trivial. The handoff doc reports a prior uncommitted attempt that placed the field directly on `UserPreferences`; verifying that those edits are not still in the working tree is part of the work.
- **Server-side global count + cap check in `createBench`** — Not present. · Candidate: inside the existing pre-`await` reservation block in `createBench`, after `findNextBenchNumber` succeeds, count `benches.size` (Map size is O(1) and includes every Project's Benches) and compare to `settings.maxBenchesGlobal`. If at cap, throw `new BenchError(..., "GLOBAL_CAP_REACHED")` before `benches.set`. This keeps reservation atomic without introducing any lock.
- **Settings validation for `maxBenchesGlobal`** — Not present. · Candidate: extend the PUT handler in `server/routes/settings.ts` with a check that `maxBenchesGlobal` is either absent/null (unlimited) or a positive integer with a sane upper bound (e.g. ≤ 999 — pick a number the spec phase nails down). Reject `0` explicitly or treat `0` as "unlimited" — needs an explicit decision but the existing validator handles negative/non-integer rejection trivially.
- **Disabled "New bench" Button + accessible tooltip** — Today the Button only disables on `createBench.isPending`. · Candidate: in `CreateBenchModal`, derive `isAtGlobalCap = (settings?.maxBenchesGlobal ?? Infinity) <= allBenches.length` and pass through `isDisabled`. Use React Aria's `TooltipTrigger` (precedent in `BenchCard.test.tsx`, `setup/SectionProjectInfo.tsx`) to attach the explanatory message. The Button already lives in a React Aria stack so accessibility wiring is mechanical. Also consider the "+ New bench" entry point on `BenchDashboard` (`setShowCreate(true)`) — the trigger that opens the modal is the more useful place to disable, since opening a modal you can't submit is worse UX than a disabled trigger.
- **Global-cap meter / status surface** — Today the dashboard only shows per-Project meters via `ProjectTile`. · Candidate: optionally surface "N / M global benches" once `maxBenchesGlobal` is set. Context only mandates the disabled-state explanation; a visible meter is desirable but not strictly required. Defer to the design stage.
- **Fail-open on corrupted `settings.json`** — `loadSettings` (state.ts:183-212) already wraps `JSON.parse` in try/catch and returns defaults on error. With `maxBenchesGlobal` defaulting to `undefined` (unlimited), corruption naturally fails open. No new code path needed; just verify in tests.

## Integration points

- **`server/services/bench-manager.ts:createBench` (line 404)** — Insert global-cap check after `findNextBenchNumber` and before `benches.set`. Read `stateService.loadSettings().maxBenchesGlobal` synchronously; compare against `benches.size`. Throw `BenchError("GLOBAL_CAP_REACHED")` on violation. No `await` in this block, by design.
- **`server/routes/benches.ts:87-97`** — Already maps `BenchError.code` to HTTP. Add `"GLOBAL_CAP_REACHED"` to the 409 branch (or rely on the existing default 400 → switch it to 409 explicitly). The combined create-and-assign flow at line 50 funnels through `issueAssignment.createBenchAndAssignIssue` which calls the same `benchManager.createBench`, so the error propagates without a second integration point. The mapper at lines 65-71 needs the same 409 branch.
- **`server/routes/settings.ts:31-123`** — Add validation for `maxBenchesGlobal` in the PUT body and include it in the `updated` object. Mirror the integer-validation pattern used for `github.issueTypesCacheTtlSeconds` (line 90-103).
- **`server/services/state.ts:loadSettings` (line 183)** — Default-merge `maxBenchesGlobal` (just `raw.maxBenchesGlobal` if shape allows, or under `benches: { ...DEFAULT, ...raw.benches }` depending on where the field lives).
- **`shared/types.ts:UserPreferences` (line 929) or `BenchSettings` (line 897)** — Add the field. Decision needed in the spec stage: `UserPreferences.maxBenchesGlobal?: number` (matches seed phrasing) vs `BenchSettings.maxBenchesGlobal?: number` (groups by domain).
- **`client/src/components/ProjectSettings.tsx:BenchesTab` (line 133) + `TAB_LABELS` (line 712)** — Add the new control (number input or "set / unlimited" pair) and rename the tab label from `"Bench Defaults"` to `"Benches"`. Note the in-tab section header on line 146 also reads "Bench Defaults" — the spec stage should decide whether that renames too.
- **`client/src/components/CreateBenchModal.tsx:120-127`** — Read `useAllBenches()` + `useSettings()`; derive cap state; pass `isDisabled` to the confirm Button and add a React Aria `TooltipTrigger` around it. Also propagate a server-error string for the 409 case in the existing `setError(...)` flow (defense in depth).
- **`client/src/components/BenchDashboard.tsx` (the "New bench" trigger that calls `setShowCreate(true)`)** — Mirror the disabled-state derivation on the entry trigger so the user sees the block before opening a modal they can't submit. The dashboard already calls `useAllBenches` indirectly via `useProjectBenches` — confirm caching shape but no new fetch should be needed.

## Concurrency

`state.json` writes go through `atomicWrite` (`server/services/state.ts:50-54`), which is a `writeFileSync` to a `.tmp` followed by `renameSync` — atomic on the filesystem (POSIX rename is atomic; macOS and Linux both honour this), but **not** serialized across concurrent in-process calls. There is no file lock, no in-process mutex, and no queue. Multiple in-flight `addBench` calls can race at the read step and clobber each other's tmp files, with last-rename winning.

However, this is **not actually a problem for the global cap** because the cap is enforced against the in-memory `benches: Map<string, Bench>` in `bench-manager.ts`, not against `state.json`. The reservation that matters happens at `benches.set(...)` in `createBench`. Node.js's single-threaded event loop guarantees that the synchronous block from `findNextBenchNumber` through the cap check through `benches.set` cannot be interleaved with another `createBench` call. The existing code relies on exactly this property for per-Project cap correctness (see the inline comment at `bench-manager.ts:414-416`) and it extends to the global cap unchanged.

The context's "strict first-write-wins via a lock around `state.json`" phrasing is misleading — the actual correctness boundary is the in-memory Map, and Node's event loop is the lock. State.json persistence happens later (inside `runWorktreeProvisioning`'s `addBench` call) and a clobber there can corrupt persisted Bench metadata but cannot violate the cap.

That said, the broader `state.json` write-race risk is **pre-existing and not introduced by this feature**. It deserves a separate paper-cut issue but should not block this build. If the spec stage decides to add real serialization (`async-mutex`, `proper-lockfile`, or a write queue), it should be scoped as its own work unit and applied uniformly to every `addBench`/`updateBench`/`removeBench` call site, not bolted onto the global cap.

## Cross-Project count

The in-memory `benches` Map already holds every initialised Bench across every Project. `benches.size` or `Array.from(benches.values()).length` is O(1) / O(n) respectively and requires no scanning of `projects.json` or per-Project state. `getBenches()` (no argument) already exposes this. On the client, `useAllBenches()` is the equivalent. No new aggregation layer is needed.

In-flight Benches in `status: "preparing"` are in the Map from the moment `createBench` sets them (line 456), before workspace provisioning starts. They are removed by `runTeardownBackground` → `benches.delete` after the workspace is removed. This matches the context's "in-flight counts as taken, only `clearBench` frees a slot" rule exactly. The only edge case is a bench that fails worktree provisioning and is left in `status: "error"` — those stay in the Map (and on disk via `stateService.addBench` is not called when worktree provisioning fails before line 835, so disk and memory can diverge here) and continue counting against the cap until the user clears them. The spec stage should explicitly confirm this is the intended behaviour for failed-provisioning Benches.

## Risks

### Technical

- **State.json write races (pre-existing, not new)** — Medium severity in general, low for this feature. The cap enforcement does not depend on state.json. Resolution: file a separate issue covering the broader state-write serialization; explicitly out of scope here.
- **`benches.size` includes error-state Benches that may have no workspace on disk** — Low. A failed worktree provisioning leaves the Bench in the in-memory Map with `status: "error"` but no on-disk workspace. The cap counts it, which is the safe direction (over-counts rather than under-counts) but may surprise users who see "1 / 5" with nothing visible. Resolution: spec stage decides whether error-state Benches should count; if not, filter on `status !== "error"` in the count.
- **Field placement decision (`UserPreferences` vs `BenchSettings`)** — Low. Both work mechanically; the choice affects default-merge code in `loadSettings` and validation shape in the PUT handler. Resolution: spec stage picks one; document the reasoning.

### Integration

- **Two `createBench` call sites must both surface the 409 cleanly** — Low. `routes/benches.ts` already handles the direct create path; `issue-assignment.ts:createBenchAndAssignIssue` wraps `createBench` and the route mapper at `routes/benches.ts:65-71` already translates `NO_BENCHES` to 409 — add `GLOBAL_CAP_REACHED` to the same branch. Resolution: add a `bench-manager` integration test that exercises both paths against the cap.
- **Prior uncommitted partial implementation in `shared/types.ts`, `state.ts`, `routes/settings.ts`, `bench-manager.ts`** — Medium. The handoff doc names four files touched in a prior session. Grep confirms no `maxBenchesGlobal` is currently present in any tracked file, so the working tree has either been reverted or the edits were never staged. Resolution: explicitly verify with `git status` / `git diff` at the start of the architecture stage; treat the prior work as discarded rather than building on it blind.

### Non-functional

- **UX of "set the cap below current count"** — Low. Context settles this: lowering is allowed; existing Benches are untouched. The disabled "New bench" affordance + tooltip already communicates the state. Resolution: confirm the tooltip copy distinguishes "you set the cap to N and have M ≥ N Benches" from "you are at N of N" if useful; otherwise one message covers both cases.
- **Accessibility of the disabled Button + tooltip** — Low. React Aria `Button isDisabled` + `TooltipTrigger` is the established pattern; precedent in `BenchCard`, `SectionProjectInfo`, `SectionLayout`. Resolution: include a screen-reader-text assertion in the component test.
- **Per-Project meter still implies per-Project caps are the limiting factor** — Low. `ProjectTile` shows "X / Y benches" per Project. When the global cap kicks in, the per-Project meter can still show capacity that the user cannot actually use. Resolution: spec/design stage decides whether to surface a global-cap indicator on the dashboard. Not strictly required by the context.

### Data

- **No schema migration** — Low. `maxBenchesGlobal` is optional; `loadSettings` already default-merges and falls back gracefully on parse failure. Existing installs are uncapped on first run after upgrade. Resolution: explicit test for "settings.json missing → unlimited" and "settings.json corrupt → unlimited + warning."

### Security

- **PUT `/api/settings` validation must reject hostile inputs** — Low. Existing route validates each settings sub-shape strictly; the same shape (positive-integer check, upper bound, reject non-integer/NaN/Infinity) covers `maxBenchesGlobal`. Resolution: copy the `Number.isInteger` / range check pattern from the `github.issueTypesCacheTtlSeconds` validator.

## Unknowns

- Field placement: `UserPreferences.maxBenchesGlobal` (matches seed phrasing) vs `BenchSettings.maxBenchesGlobal` (groups by domain). Affects validator and default-merge shape.
- Treatment of `0`: explicitly invalid (must be ≥ 1) vs synonym for "unlimited" alongside `null`/absent. Recommend explicitly invalid to keep the "unlimited = absent" rule unambiguous.
- Upper bound: is there a sane max (e.g. 50, 100, 999) above which we reject? Per-Project `benches.max` is capped at 99 today; a global cap with no upper bound may be intentional but should be confirmed.
- Whether error-state Benches (failed worktree provisioning, no workspace on disk) should count against the cap. Defaulting to "yes" is safer; spec should make this explicit.
- Where on the dashboard the global "N / M" indicator lives (if at all). Context only requires the disabled-state explanation on the create affordance.
- Whether the in-tab section header "Bench Defaults" at line 146 of `ProjectSettings.tsx` renames alongside the tab label `"Benches"` (context names only the tab label).

Recommendation: **build**
