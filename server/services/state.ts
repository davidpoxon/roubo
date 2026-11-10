import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_JIG_SETTINGS,
  DEFAULT_BENCH_SETTINGS,
  DEFAULT_TESTBENCH_SETTINGS,
  DEFAULT_GITHUB_SETTINGS,
} from "@roubo/shared";
import { PROJECT_ID_RE, assertSafeIdentifier, resolveWithin } from "../lib/safe-path.js";
import { hashContent, markSelfWrite, pendingHandEdit } from "./self-write-tokens.js";
import type {
  AssignedIssue,
  Bench,
  JigDefaultSource,
  PersistedProjects,
  PersistedProjectEntry,
  PersistedState,
  PersistedBench,
  UserPreferences,
  ProjectPermissions,
} from "@roubo/shared";

function resolveRouboDir(): string {
  if (process.env.ROUBO_PRODUCTION) {
    return path.join(os.homedir(), ".roubo");
  }
  // state.ts lives at <root>/server/services/state.ts: go up 2 levels to reach project root.
  // This only runs in dev mode (ROUBO_PRODUCTION unset), where tsx executes the .ts source directly.
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  // Uses the checkout directory name as the isolation key. Two checkouts with the
  // same directory name will share a dev state directory: acceptable tradeoff.
  return path.join(os.homedir(), ".roubo-dev", path.basename(projectRoot));
}

const ROUBO_DIR = resolveRouboDir();
const WORKSPACES_DIR = path.join(ROUBO_DIR, "workspaces");
const PROJECTS_FILE = path.join(ROUBO_DIR, "projects.json");
const STATE_FILE = path.join(ROUBO_DIR, "state.json");
const SETTINGS_FILE = path.join(ROUBO_DIR, "settings.json");
const PERMISSIONS_DIR = path.join(ROUBO_DIR, "permissions");

let dirsEnsured = false;
export function ensureDirs() {
  if (dirsEnsured) return;
  fs.mkdirSync(ROUBO_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
  fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });
  dirsEnsured = true;
}

/**
 * Write `data` to `filePath` through a tmp sibling and a rename, marked as the
 * app's own write. `known`, for a write that keeps a hand edit the watch has
 * not run for yet, is the content without that edit: what the app means the
 * file to hold, kept as its known content so the edit stays pending.
 */
export function atomicWrite(filePath: string, data: string, mode?: number, known?: string) {
  // Defence-in-depth containment: callers are expected to have already validated
  // `filePath`, but re-resolve via path.resolve + relative check so CodeQL sees a
  // sanitizer immediately before the file ops. This is the same shape the default
  // js/path-injection suite recognises.
  const resolvedFile = path.resolve(filePath);
  const parent = path.dirname(resolvedFile);
  const rel = path.relative(parent, resolvedFile);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`atomicWrite: invalid file path: ${filePath}`);
  }
  const tmp = resolvedFile + ".tmp";
  fs.writeFileSync(tmp, data, { encoding: "utf-8", mode: mode ?? 0o666 });
  // Mark the write before the rename, so the InputWatcher event the rename
  // raises is taken as the server's own write and runs no reload handler.
  markSelfWrite(resolvedFile, hashContent(data), known ?? data);
  fs.renameSync(tmp, resolvedFile);
}

export function getRouboDir(): string {
  return ROUBO_DIR;
}

export function getWorkspacesDir(): string {
  return WORKSPACES_DIR;
}

export function sanitizeBranchForPath(branch: string): string {
  // Trim leading/trailing runs of '-'/'.' with explicit index walks rather than a
  // regex. An anchored `/[-.]+$/` trim is reported as js/polynomial-redos because the
  // greedy quantifier can backtrack on long separator runs; index walks are strictly
  // linear with no backtracking surface.
  const slashed = branch.replace(/\//g, "-");
  const isTrimChar = (c: string) => c === "-" || c === ".";
  let start = 0;
  let end = slashed.length;
  while (start < end && isTrimChar(slashed[start])) start++;
  while (end > start && isTrimChar(slashed[end - 1])) end--;
  return slashed.slice(start, end) || "branch";
}

/**
 * The directory every bench workspace for one project is provisioned under
 * (`<rouboDir>/workspaces/<projectName>`), i.e. the parent of every
 * `getWorkspacePath(projectName, ...)`. Exposed so a caller that needs to drop a
 * project's workspaces wholesale (the e2e fixture-project cleanup in
 * routes/test.ts, #1102) resolves the same containment-checked path the
 * provisioning side does, rather than re-joining `getWorkspacesDir()` by hand.
 */
export function getProjectWorkspacesDir(projectName: string): string {
  assertSafeIdentifier(projectName, PROJECT_ID_RE, "projectName");
  return resolveWithin(WORKSPACES_DIR, projectName);
}

export function getWorkspacePath(
  projectName: string,
  benchNumber: number,
  branch?: string,
): string {
  assertSafeIdentifier(projectName, PROJECT_ID_RE, "projectName");
  if (!Number.isInteger(benchNumber) || benchNumber < 0) {
    throw new Error(`Invalid bench number: ${benchNumber}`);
  }
  const dirName = branch
    ? `bench-${benchNumber}-${sanitizeBranchForPath(branch)}`
    : `bench-${benchNumber}`;
  return resolveWithin(WORKSPACES_DIR, projectName, dirName);
}

export function loadProjects(): PersistedProjects {
  ensureDirs();
  if (!fs.existsSync(PROJECTS_FILE)) {
    return { projects: [] };
  }
  return JSON.parse(fs.readFileSync(PROJECTS_FILE, "utf-8"));
}

export function saveProjects(data: PersistedProjects) {
  ensureDirs();
  atomicWrite(PROJECTS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Fills integrationId + externalId on a pre-plugin assignedIssue snapshot.
 * Pre-plugin benches only have `number` and `title`; this defaults them to
 * the github-com integration and stringifies `number` into `externalId`.
 * Idempotent: a fully-formed snapshot passes through unchanged.
 */
export function migrateAssignedIssue(issue: AssignedIssue | undefined): AssignedIssue | undefined {
  if (!issue) return issue;
  if (issue.integrationId && issue.externalId) return issue;
  return {
    ...issue,
    integrationId: issue.integrationId ?? "github-com",
    externalId: issue.externalId ?? String(issue.number ?? ""),
  };
}

/**
 * One-shot rename of legacy `injectedBlueprintId` / `injectedBlueprintSource`
 * keys on a persisted bench to the new `injectedJigId` / `injectedJigSource`
 * names. Idempotent: re-running on already-migrated data is a no-op.
 */
function migrateInjectedJigFields(bench: PersistedBench): void {
  const raw = bench as unknown as Record<string, unknown>;
  if (raw.injectedJigId === undefined && typeof raw.injectedBlueprintId === "string") {
    bench.injectedJigId = raw.injectedBlueprintId as string;
  }
  if (raw.injectedJigSource === undefined && typeof raw.injectedBlueprintSource === "string") {
    bench.injectedJigSource = raw.injectedBlueprintSource as JigDefaultSource;
  }
  delete raw.injectedBlueprintId;
  delete raw.injectedBlueprintSource;
}

export function loadState(): PersistedState {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    return { benches: [] };
  }
  return migratePersistedState(JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")));
}

/**
 * Migrate the legacy fields of each bench record of a parsed state.json in
 * place, as every read of the file does, and return it.
 */
export function migratePersistedState(data: PersistedState): PersistedState {
  for (const bench of data.benches) {
    bench.assignedIssue = migrateAssignedIssue(bench.assignedIssue);
    migrateInjectedJigFields(bench);
  }
  return data;
}

/**
 * Write state.json and record it as the known content.
 *
 * Every app write of the file is read-modify-write: `data` is what was read
 * from disk with the app's change on it. When the file holds a hand edit that
 * the state dir watch has not run for yet, `data` carries that edit, and
 * recording it as known would take it in unchecked: a refused change of a live
 * bench would stay in the file, and an edit of an idle bench would never reach
 * memory. So the edit is left in the file and kept out of the known content,
 * which gets the app's change only (see `overHandEdit`). The watch then runs
 * its handler for the edit, diffing it against the known content.
 */
export function saveState(data: PersistedState) {
  ensureDirs();
  const merged = overHandEdit(data);
  if (merged === null) {
    atomicWrite(STATE_FILE, JSON.stringify(data, null, 2));
    rememberState(data);
    return;
  }
  atomicWrite(
    STATE_FILE,
    JSON.stringify(merged.written, null, 2),
    undefined,
    JSON.stringify(merged.known, null, 2),
  );
  rememberState(merged.known);
}

/** A JSON text of `value` with its object keys sorted, for comparing content. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function recordKey(record: { projectId: string; id: number }): string {
  return `${record.projectId}\u0000${record.id}`;
}

/**
 * The app's record with each field that the hand edit changed (the disk record
 * differs from the known one) taken from the disk record, so the edit stays in
 * the file for the watch to apply or refuse.
 */
function keepHandEditedFields(
  app: PersistedBench,
  disk: PersistedBench | undefined,
  known: PersistedBench | undefined,
): PersistedBench {
  if (disk === undefined || known === undefined) return app;
  const diskFields = disk as unknown as Record<string, unknown>;
  const knownFields = known as unknown as Record<string, unknown>;
  const edited = new Set(
    [...Object.keys(diskFields), ...Object.keys(knownFields)].filter(
      (field) => !sameJson(diskFields[field], knownFields[field]),
    ),
  );
  if (edited.size === 0) return app;
  const out = Object.entries(app as unknown as Record<string, unknown>).filter(
    ([field]) => !edited.has(field),
  );
  for (const field of edited) {
    if (Object.hasOwn(diskFields, field)) out.push([field, diskFields[field]]);
  }
  return Object.fromEntries(out) as unknown as PersistedBench;
}

/** The parsed state.json on disk, or null when it is absent or does not parse. */
function readStateFileForMerge(): PersistedState | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const benches = (parsed as { benches?: unknown }).benches;
    if (!Array.isArray(benches)) return null;
    return migratePersistedState(parsed as PersistedState);
  } catch {
    return null;
  }
}

/**
 * When state.json holds a hand edit that the watch has not run for yet, what
 * to write and what to record as known for an app write of `data`; null when
 * there is no such edit. Each record and top-level key that `data` holds as
 * the disk does is the app's read of it, not its change: the file keeps the
 * disk's, and the known content keeps the known one. Each that differs is the
 * app's change: the known content takes it, and the file takes it too, with
 * the fields the hand edit changed kept from the disk.
 */
function overHandEdit(
  data: PersistedState,
): { written: PersistedState; known: PersistedState } | null {
  if (knownState === null || pendingHandEdit(STATE_FILE) === undefined) return null;
  const disk = readStateFileForMerge();
  if (disk === null) return null;
  const knownBase = knownState;
  const top = new Set([...Object.keys(data), ...Object.keys(disk), ...Object.keys(knownBase)]);
  top.delete("benches");
  const written: Record<string, unknown> = {};
  const known: Record<string, unknown> = {};
  const dataFields = data as unknown as Record<string, unknown>;
  const diskFields = disk as unknown as Record<string, unknown>;
  const knownFields = knownBase as unknown as Record<string, unknown>;
  for (const key of top) {
    const unchanged = sameJson(dataFields[key], diskFields[key]);
    const writtenValue = unchanged ? diskFields[key] : dataFields[key];
    const knownValue = unchanged ? knownFields[key] : dataFields[key];
    if (writtenValue !== undefined) written[key] = writtenValue;
    if (knownValue !== undefined) known[key] = knownValue;
  }
  const diskRecords = new Map(disk.benches.map((r) => [recordKey(r), r]));
  const knownRecords = new Map(knownBase.benches.map((r) => [recordKey(r), r]));
  const writtenBenches: PersistedBench[] = [];
  const knownBenches: PersistedBench[] = [];
  const held = new Set<string>();
  for (const record of data.benches) {
    const key = recordKey(record);
    held.add(key);
    const onDisk = diskRecords.get(key);
    const wasKnown = knownRecords.get(key);
    if (onDisk !== undefined && sameJson(record, onDisk)) {
      writtenBenches.push(onDisk);
      // A record that the hand edit added stays out of the known content.
      if (wasKnown !== undefined) knownBenches.push(wasKnown);
    } else {
      writtenBenches.push(keepHandEditedFields(record, onDisk, wasKnown));
      knownBenches.push(record);
    }
  }
  for (const [key, record] of knownRecords) {
    // A known record that the disk no longer holds was removed by the hand
    // edit, not by the app: the known content keeps it.
    if (!held.has(key) && !diskRecords.has(key)) knownBenches.push(record);
  }
  return {
    written: { ...written, benches: writtenBenches } as unknown as PersistedState,
    known: { ...known, benches: knownBenches } as unknown as PersistedState,
  };
}

/**
 * The content of state.json as the app last knows it: what the app last wrote,
 * what it read at boot, or the last hand edit that the watch took in. A hand
 * edit is diffed against it, so a field that the edit did not touch is never
 * taken as edited, even when the bench in memory holds a default that the file
 * never carried (HR-FR-013). Null until the app has read or written the file.
 */
let knownState: PersistedState | null = null;

/** Record `data` as the content state.json holds now. */
export function rememberState(data: PersistedState): void {
  knownState = structuredClone(data);
}

/** The content state.json held when the app last read or wrote it, or null. */
export function getKnownState(): PersistedState | null {
  return knownState === null ? null : structuredClone(knownState);
}

export function addProject(entry: PersistedProjectEntry) {
  const data = loadProjects();
  data.projects = data.projects.filter((a) => a.id !== entry.id);
  data.projects.push(entry);
  saveProjects(data);
}

export function removeProject(projectId: string) {
  const data = loadProjects();
  data.projects = data.projects.filter((a) => a.id !== projectId);
  saveProjects(data);
}

export function addBench(bench: PersistedBench) {
  const data = loadState();
  data.benches = data.benches.filter(
    (b) => !(b.projectId === bench.projectId && b.id === bench.id),
  );
  data.benches.push(bench);
  saveState(data);
}

/**
 * Replaces an existing persisted bench in place. Deliberately a no-op when no
 * record with this (projectId, id) exists: creation is `addBench`'s job.
 *
 * This asymmetry is the fix for #1191. Background writers hold a `Bench`
 * reference across awaits (component setup, PTY-driven notifications, container
 * assignment); if a teardown clears the bench in that window, an upserting
 * update re-adds the record to state.json. Memory then says the bench is gone
 * while state.json still lists it, so the Benches view renders nothing, the
 * unregister guard still counts one, and the next launch hydrates the phantom
 * back into the UI. A no-op-when-absent update closes that window for every
 * writer at once, including the in-thread gap between `removeBench` and the
 * `benches.delete` that follows it.
 */
export function updateBench(bench: PersistedBench) {
  const data = loadState();
  const index = data.benches.findIndex((b) => b.projectId === bench.projectId && b.id === bench.id);
  if (index === -1) return;
  data.benches[index] = bench;
  saveState(data);
}

/**
 * The persisted mirror of every runtime-reported component URL (#1206). Only the
 * components that actually reported one are carried, and a bench where none did
 * writes no key at all, so state.json gains nothing for projects that never use
 * the feature.
 */
function toComponentUrls(components: Bench["components"]): Record<string, string> | undefined {
  const urls: Record<string, string> = {};
  for (const [name, component] of Object.entries(components)) {
    if (component.url) urls[name] = component.url;
  }
  return Object.keys(urls).length > 0 ? urls : undefined;
}

/**
 * Extracts the persisted subset of a Bench, stripping runtime-only fields
 * (status, components, error, provisioningSteps, teardownSteps, and the derived
 * `stale`).
 *
 * NFR-004 audit: `bench.assignedIssue.raw` is the one place a plugin-supplied
 * `raw` may live in state.json. It rides through this function with
 * `assignedIssue` (passed by reference) and is removed when the bench is
 * filtered out in `removeBench`. `bench.notifications[].launchFailure` is a
 * second: an agent-launch-failed notice can carry a plugin's declared
 * `remedy` and the agent's own captured output (redacted before storage in
 * notification.ts's createNotification, unlike `raw`, which is not).
 */
export function toPersistedBench(bench: Bench): PersistedBench {
  return {
    id: bench.id,
    projectId: bench.projectId,
    branch: bench.branch,
    workspacePath: bench.workspacePath,
    ports: bench.ports,
    createdAt: bench.createdAt,
    assignedContainers: bench.assignedContainers,
    assignedIssue: bench.assignedIssue,
    notifications: bench.notifications,
    baseBranch: bench.baseBranch,
    baseCommit: bench.baseCommit,
    injectedJigId: bench.injectedJigId,
    injectedJigSource: bench.injectedJigSource,
    variant: bench.variant,
    focusedSpecPath: bench.focusedSpecPath,
    componentSetupState: Object.fromEntries(
      Object.entries(bench.components).map(([name, c]) => [name, c.setupComplete]),
    ),
    componentUrls: toComponentUrls(bench.components),
    benchSetupComplete: bench.benchSetupComplete,
    // Written only when set, so a legacy bench gains no snapshot key until it
    // takes one (HR-TC-006). `stale` is derived on each read and never written.
    ...(bench.componentSnapshot !== undefined && { componentSnapshot: bench.componentSnapshot }),
    // The Spec Bench fields are written only when set, so a record of any other
    // bench carries no delivery key at all, not even an undefined one (SB-TC-008).
    ...(bench.deliveryBindMode !== undefined && { deliveryBindMode: bench.deliveryBindMode }),
    ...(bench.deliveryDecisionMode !== undefined && {
      deliveryDecisionMode: bench.deliveryDecisionMode,
    }),
    ...(bench.gatePin !== undefined && { gatePin: bench.gatePin }),
    ...(bench.deliveryTokenHash !== undefined && { deliveryTokenHash: bench.deliveryTokenHash }),
    ...(bench.deliveryControlQueue !== undefined && {
      deliveryControlQueue: bench.deliveryControlQueue,
    }),
    ...(bench.deliveryControlSeq !== undefined && {
      deliveryControlSeq: bench.deliveryControlSeq,
    }),
    ...(bench.deliverySitting !== undefined && { deliverySitting: bench.deliverySitting }),
    ...(bench.deliveryLastViewedSeq !== undefined && {
      deliveryLastViewedSeq: bench.deliveryLastViewedSeq,
    }),
    ...(bench.deliveryLastViewedDeliveryId !== undefined && {
      deliveryLastViewedDeliveryId: bench.deliveryLastViewedDeliveryId,
    }),
    ...(bench.deliveryFirstSeenBlocking !== undefined && {
      deliveryFirstSeenBlocking: bench.deliveryFirstSeenBlocking,
    }),
    ...(bench.deliveryFirstSeenBlockingClass !== undefined && {
      deliveryFirstSeenBlockingClass: bench.deliveryFirstSeenBlockingClass,
    }),
    ...(bench.deliveryCrossCheckMemory !== undefined && {
      deliveryCrossCheckMemory: bench.deliveryCrossCheckMemory,
    }),
  };
}

export function removeBench(projectId: string, benchId: number) {
  const data = loadState();
  data.benches = data.benches.filter((b) => !(b.projectId === projectId && b.id === benchId));
  saveState(data);
}

function defaultSettings(): UserPreferences {
  return {
    theme: "dark",
    jigs: DEFAULT_JIG_SETTINGS,
    benches: DEFAULT_BENCH_SETTINGS,
    testBench: DEFAULT_TESTBENCH_SETTINGS,
    github: DEFAULT_GITHUB_SETTINGS,
  };
}

/**
 * The settings of the last read of settings.json that parsed or of the app's
 * last write of it, whichever came later, or null when neither has happened yet
 * in this process. A hand edit that leaves the file unparseable keeps serving
 * it (HR-TC-034).
 */
let lastGoodSettings: UserPreferences | null = null;

export function loadSettings(opts?: { throwOnCorrupt?: boolean }): UserPreferences {
  ensureDirs();
  if (!fs.existsSync(SETTINGS_FILE)) {
    return defaultSettings();
  }
  try {
    const settings = parseSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8")));
    lastGoodSettings = structuredClone(settings);
    return settings;
  } catch (err) {
    // Fail-open by default: a corrupt settings.json yields the last settings
    // that parsed in this process, or the built-in defaults when none has yet,
    // so the app keeps working. Callers that need to distinguish corruption
    // from a legitimately-default config (e.g. the global bench-cap check,
    // which warns once per process load) opt in via throwOnCorrupt. A missing
    // file is handled by the early return above and never reaches here, so
    // absence never throws.
    if (opts?.throwOnCorrupt) {
      throw err;
    }
    return lastGoodSettings === null ? defaultSettings() : structuredClone(lastGoodSettings);
  }
}

/** Forget the last settings that parsed. For tests. */
export function resetLastGoodSettings(): void {
  lastGoodSettings = null;
}

/** The settings a parsed settings.json holds, legacy keys migrated and defaults filled in. */
function parseSettings(raw: ReturnType<typeof JSON.parse>): UserPreferences {
  // Legacy migration: the `blueprints` object plus its `defaultBlueprintId`
  // sub-key were renamed to `jigs` / `defaultJigId`. Honor old keys only if
  // the new ones are absent, so a user-authored settings file keeps working.
  const legacyJigSettings = raw.blueprints as
    (Record<string, unknown> & { defaultBlueprintId?: string }) | undefined;
  const mergedJigSettings = {
    ...DEFAULT_JIG_SETTINGS,
    ...(legacyJigSettings ?? {}),
    ...raw.jigs,
  } as Record<string, unknown>;
  if (
    mergedJigSettings.defaultJigId === undefined &&
    typeof legacyJigSettings?.defaultBlueprintId === "string"
  ) {
    mergedJigSettings.defaultJigId = legacyJigSettings.defaultBlueprintId;
  }
  delete mergedJigSettings.defaultBlueprintId;
  return {
    theme: raw.theme ?? "dark",
    jigs: mergedJigSettings as UserPreferences["jigs"],
    // AP-FR-008 (found while writing the AP-TC-025 e2e, #1101): the app-level
    // agent tool presets have to be read back explicitly. This object is
    // rebuilt key by key rather than spread from `raw`, so an unlisted key is
    // dropped on EVERY read: `listAppAgentPresets` saw no presets, the editor
    // re-rendered an empty list, and the next settings write erased the file's
    // copy too (PUT /api/settings falls back to `current.agentTools`). Saving
    // an agent tool therefore never survived a reload.
    ...(Array.isArray(raw.agentTools) && {
      agentTools: raw.agentTools as UserPreferences["agentTools"],
    }),
    benches: { ...DEFAULT_BENCH_SETTINGS, ...raw.benches },
    testBench: { ...DEFAULT_TESTBENCH_SETTINGS, ...raw.testBench },
    github: { ...DEFAULT_GITHUB_SETTINGS, ...raw.github },
  };
}

export function saveSettings(data: UserPreferences) {
  ensureDirs();
  // `UserPreferences` no longer models the retired built-in agent block, but a
  // whole-file rewrite would drop it, and that block is the only signal an
  // install is an upgrade (see `hasLegacyAgentSettings`). Carry it across every
  // save so an unrelated settings change cannot silently retire the first-run
  // notice before the user has seen it (AP-FR-021, AP-TC-109).
  const legacy = readLegacyAgentSettings();
  const payload = legacy === undefined ? data : { ...data, [LEGACY_AGENT_SETTINGS_KEY]: legacy };
  writeSettingsFile(payload);
}

/**
 * Write settings.json and make what was written the last good settings, so a
 * later hand edit that leaves the file unparseable serves this write rather
 * than the read before it (HR-TC-034). Every writer of settings.json goes
 * through here.
 */
function writeSettingsFile(payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  atomicWrite(SETTINGS_FILE, text);
  lastGoodSettings = parseSettings(JSON.parse(text));
}

/**
 * The key the retired built-in agent preferences were stored under. It is a
 * legacy FILE key, not a `UserPreferences` field: #1114 removed the field, and
 * nothing reads or writes this block any more. It is named in exactly one place
 * so the core-purity guard can allowlist that one place (AP-FR-021).
 */
const LEGACY_AGENT_SETTINGS_KEY = "claudeCode";

/**
 * The raw legacy block as it sits on disk, or `undefined` when absent. Reads
 * the file directly because `loadSettings` does not model the key at all.
 */
function readLegacyAgentSettings(): unknown {
  if (!fs.existsSync(SETTINGS_FILE)) return undefined;
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    return (raw as Record<string, unknown>)[LEGACY_AGENT_SETTINGS_KEY];
  } catch {
    return undefined;
  }
}

/**
 * True when `settings.json` still carries the retired built-in agent
 * preferences block, which is the ONLY signal that this install is an upgrade
 * rather than a fresh one (AP-FR-021, AP-TC-110).
 *
 * Deliberately reads the raw file: `loadSettings` merges defaults in, so its
 * result can never distinguish "the user had this block" from "we filled it
 * in". Nothing is migrated from the block and nothing removes it: `saveSettings`
 * carries it across whole-file rewrites, so the signal survives until the user
 * edits `settings.json` by hand.
 */
export function hasLegacyAgentSettings(): boolean {
  return readLegacyAgentSettings() !== undefined;
}

/**
 * Plant or remove the retired built-in agent preferences block (AP-FR-021).
 *
 * A TEST SEAM, reachable only through `POST /test/__seed-legacy-agent-settings`
 * under `ROUBO_E2E=1`. The block is the one signal that an install is an
 * upgrade, and nothing in the product ever writes it: it is a residue of a build
 * that predates the agent plugins. So the "existing user upgrades" journey
 * (AP-TC-102) has no other way to reach its own precondition, and a spec cannot
 * write `settings.json` itself without knowing the key, which would be a second
 * place naming it.
 *
 * It lives here, beside `readLegacyAgentSettings`, precisely so it does not
 * become that second place: `LEGACY_AGENT_SETTINGS_KEY` stays named exactly once
 * (AP-NFR-006). `null` removes the block, which is what lets the journey hand
 * the environment back as a fresh install (NFR-018).
 */
export function writeLegacyAgentSettings(block: Record<string, unknown> | null): void {
  ensureDirs();
  let raw: Record<string, unknown> = {};
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      // A corrupt settings file is replaced rather than merged into: the seam's
      // job is to leave the block in a known state, not to salvage the rest.
      raw = {};
    }
  }
  // Rebuilt by omission rather than with `delete`, which the lint rules forbid
  // on a computed key: the block is the only key this seam owns, so dropping it
  // from a filtered copy is exactly equivalent and keeps the rest untouched.
  const next = Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== LEGACY_AGENT_SETTINGS_KEY),
  );
  writeSettingsFile(block === null ? next : { ...next, [LEGACY_AGENT_SETTINGS_KEY]: block });
}

export function getPersistedBenches(projectId?: string): PersistedBench[] {
  const data = loadState();
  if (projectId) {
    return data.benches.filter((b) => b.projectId === projectId);
  }
  return data.benches;
}

function resolvePermissionsPath(projectId: string): string {
  // Regex-validate projectId so CodeQL recognises a sanitizer barrier on the
  // tainted segment, then re-confine via resolveWithin (path.relative shape).
  assertSafeIdentifier(projectId, PROJECT_ID_RE, "projectId");
  return resolveWithin(PERMISSIONS_DIR, `${projectId}.json`);
}

export function getProjectPermissions(projectId: string): ProjectPermissions {
  const filePath = resolvePermissionsPath(projectId);
  if (!fs.existsSync(filePath)) {
    return { allow: [], deny: [], ask: [] };
  }
  try {
    const data: Partial<ProjectPermissions> = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      allow: data.allow ?? [],
      deny: data.deny ?? [],
      ask: data.ask ?? [],
      // A file written before the posture axis existed simply carries none, and
      // no posture means the agent keeps whatever mode its own config selected.
      ...(data.posture !== undefined && { posture: data.posture }),
    };
  } catch {
    return { allow: [], deny: [], ask: [] };
  }
}

export function setProjectPermissions(projectId: string, permissions: ProjectPermissions): void {
  const filePath = resolvePermissionsPath(projectId);
  fs.mkdirSync(PERMISSIONS_DIR, { recursive: true });
  atomicWrite(filePath, JSON.stringify(permissions, null, 2));
}
