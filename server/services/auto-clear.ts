import type { Bench, BenchWorkUnit, NormalizedIssue, UserPreferences } from "@roubo/shared";
import { DONE_STATUSES } from "@roubo/shared";
import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as githubService from "./github.js";
import { resolveActivePlugin } from "./active-plugin.js";
import * as pluginManager from "./plugin-manager.js";
import { isAlertExternalId } from "./alert-external-id.js";
import { buildKnownMergedLocations, getDirtyState } from "./git-state.js";
import * as notificationService from "./notification.js";
import { syncAllWorkUnitPRs } from "./pr-sync.js";
import { loadSettings } from "./state.js";

const TWO_MINUTES_MS = 2 * 60 * 1000;

const POLL_INTERVAL_MS = 30_000;

// Shorter than the 30s default RPC timeout (= the poll interval) so a hung
// plugin cannot stall a whole auto-clear pass while fetching alert state.
const ALERT_FETCH_TIMEOUT_MS = 15_000;

type AutoClearReason =
  | "merged"
  | "closed"
  | "legacy-issue-closed"
  | "alert-resolved"
  | "blocked:open-pr"
  | "blocked:sync-error"
  | "blocked:stale-sync";

interface WorkUnitClassification {
  done: boolean;
  reason: AutoClearReason;
  /** For blocked results, which work unit caused the block */
  blockingSubmodule?: string;
}

let intervalId: ReturnType<typeof setInterval> | undefined;

export function start(): void {
  if (intervalId !== undefined) return;
  intervalId = setInterval(() => {
    checkAndClearDoneBenches().catch(console.error);
  }, POLL_INTERVAL_MS);
}

export function stop(): void {
  if (intervalId !== undefined) {
    clearInterval(intervalId);
    intervalId = undefined;
  }
}

/**
 * Classifies a meta-repo bench's work units to determine if it is ready for auto-clear.
 * A bench is done only when every work unit's PR is merged or closed, sync is fresh
 * (< 2 minutes old), and no unit has a syncError.
 */
export function classifyWorkUnitBench(workUnits: BenchWorkUnit[]): WorkUnitClassification {
  if (workUnits.length === 0) return { done: false, reason: "blocked:open-pr" };
  const activeUnits = workUnits.filter((wu) => !wu.ignoredForAutoClear);
  if (activeUnits.length === 0) return { done: true, reason: "closed" };
  for (const wu of activeUnits) {
    if (wu.syncError) {
      return {
        done: false,
        reason: "blocked:sync-error",
        blockingSubmodule: wu.submodule,
      };
    }
    if (!wu.lastSyncedAt || Date.now() - new Date(wu.lastSyncedAt).getTime() > TWO_MINUTES_MS) {
      return {
        done: false,
        reason: "blocked:stale-sync",
        blockingSubmodule: wu.submodule,
      };
    }
    if (!wu.pullRequest || wu.pullRequest.state === "open") {
      return {
        done: false,
        reason: "blocked:open-pr",
        blockingSubmodule: wu.submodule,
      };
    }
  }
  const anyMerged = activeUnits.some((wu) => wu.pullRequest?.merged);
  return { done: true, reason: anyMerged ? "merged" : "closed" };
}

export async function checkAndClearDoneBenches(): Promise<void> {
  const allBenches = benchManager.getBenches();

  // Only check benches that have an assigned issue and are in a stable state
  const eligible = allBenches.filter(
    (b) => b.assignedIssue != null && (b.status === "idle" || b.status === "active"),
  );

  if (eligible.length === 0) return;

  // Group by projectId
  const byProject = new Map<string, typeof eligible>();
  for (const bench of eligible) {
    const group = byProject.get(bench.projectId) ?? [];
    group.push(bench);
    byProject.set(bench.projectId, group);
  }

  // PR sync for meta-repo work units: runs before auto-clear classification.
  try {
    await syncAllWorkUnitPRs(byProject);
  } catch (err) {
    console.error("[auto-clear] PR sync error:", err);
  }

  const settings = loadSettings();
  for (const [projectId, benches] of byProject) {
    const workUnitAutoClear = projectRegistry.resolveWorkUnitAutoClear(projectId, settings);
    try {
      await checkProjectBenches(projectId, benches, workUnitAutoClear, settings);
    } catch (err) {
      console.error(`[auto-clear] Error checking project ${projectId}:`, err);
    }
  }
}

async function safeTeardown(projectId: string, bench: Bench): Promise<void> {
  // Compute dirty state first, suppressing the unpushed/no-upstream checks for
  // submodules whose PR is known merged. Their remote branch may be deleted
  // and the local commits squash-merged, both of which produce false positives.
  const dirty = await getDirtyState(bench, {
    knownMergedLocations: buildKnownMergedLocations(bench),
  });

  const stale = bench.notifications.filter((n) => n.type === "teardown-blocked");

  if (!dirty.clean) {
    // Still dirty: keep any existing teardown-blocked notification sticky so we
    // do not spam the user, and only create a new one if none exists yet.
    if (stale.length === 0) {
      console.log(
        `[auto-clear] Skipping teardown of bench ${bench.id} (project ${projectId}): ` +
          `${dirty.reasons.length} dirty reason(s)`,
      );
      notificationService.createNotification(bench, "teardown-blocked", undefined, {
        dirtyReasons: dirty.reasons,
      });
    }
    return;
  }

  // Clean now. Dismiss any prior teardown-blocked notification so its dismissal
  // is not stranded after the underlying state self-heals (e.g. a merged PR's
  // remote branch was deleted, and the new git-cherry path now recognises the
  // local commits as patch-equivalent on the default branch).
  for (const n of stale) {
    notificationService.dismissOne(bench, n.id);
  }

  try {
    benchManager.teardownBench(projectId, bench.id, true);
  } catch (err) {
    console.error(`[auto-clear] Could not tear down bench ${bench.id}:`, err);
  }
}

/**
 * Classify alert-backed benches for auto-clear (#289). Each bench's alert is
 * re-fetched through the active integration plugin's `getIssue` by `externalId`
 * (never by issue number, to avoid the alert/issue number collision). A bench is
 * cleared once its alert is no longer open (i.e. fixed or dismissed). Fetch
 * failures leave the bench untouched so a transient error never tears down work.
 */
async function classifyAlertBenches(projectId: string, alertBenches: Bench[]): Promise<void> {
  const active = resolveActivePlugin(projectId);
  if (!active) {
    console.debug(
      `[auto-clear] Skipping ${alertBenches.length} alert-backed bench(es) in project ${projectId} ` +
        `(no active integration plugin)`,
    );
    return;
  }

  await Promise.all(
    alertBenches.map(async (bench) => {
      const externalId = bench.assignedIssue?.externalId;
      if (!externalId) return;
      try {
        const issue = await pluginManager.invoke<NormalizedIssue>(
          active.pluginId,
          "getIssue",
          { externalId },
          { timeoutMs: ALERT_FETCH_TIMEOUT_MS },
        );
        if (issue.currentState !== "open") {
          console.log(
            `[auto-clear] Clearing bench ${bench.id} (project ${projectId}): ` +
              `alert ${externalId} state is "${issue.currentState}" reason=alert-resolved`,
          );
          await safeTeardown(projectId, bench);
        }
      } catch (err) {
        console.error(
          `[auto-clear] Could not fetch alert ${externalId} for project ${projectId}:`,
          err,
        );
      }
    }),
  );
}

async function checkProjectBenches(
  projectId: string,
  benches: ReturnType<typeof benchManager.getBenches>,
  workUnitAutoClear: boolean,
  settings: UserPreferences,
): Promise<void> {
  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return;

  const { config } = project;

  if (!projectRegistry.resolveAutoClear(projectId, settings)) return;

  // Split benches by type. Alert-backed benches have no GitHub issue to re-fetch
  // by number, and their assignedIssue.number is an alert number that could
  // collide with an unrelated issue #N, so they must never enter the issue-state
  // classification below; they are classified by alert state instead (#289).
  const workUnitBenches = benches.filter((b) => b.workUnits && b.workUnits.length > 0);
  const alertBenches = benches.filter(
    (b) =>
      (!b.workUnits || b.workUnits.length === 0) && isAlertExternalId(b.assignedIssue?.externalId),
  );
  const legacyBenches = benches.filter(
    (b) =>
      (!b.workUnits || b.workUnits.length === 0) &&
      !isAlertExternalId(b.assignedIssue?.externalId) &&
      // Interim: this path is keyed on a GitHub issue number, so skip
      // integrations with no numeric issue (e.g. Jira). The whole feature is
      // removed in PR 2.
      b.assignedIssue?.number != null,
  );

  // --- Alert-backed bench classification (#289) ---
  // Re-fetch each alert via the active plugin's getIssue by externalId (never by
  // issue number) and clear once the alert is no longer open (fixed/dismissed).
  if (alertBenches.length > 0) {
    await classifyAlertBenches(projectId, alertBenches);
  }

  // --- Work-unit bench classification ---
  if (workUnitAutoClear) {
    for (const bench of workUnitBenches) {
      const classification = classifyWorkUnitBench(bench.workUnits ?? []);
      if (classification.done) {
        console.log(
          `[auto-clear] Clearing bench ${bench.id} (project ${projectId}): ` +
            `all work units done-or-ignored reason=${classification.reason}`,
        );
        try {
          await safeTeardown(projectId, bench);
        } catch (err) {
          console.error(`[auto-clear] Could not process bench ${bench.id}:`, err);
        }
      } else {
        console.debug(
          `[auto-clear] Bench ${bench.id} (project ${projectId}) not ready: ` +
            `reason=${classification.reason} submodule=${classification.blockingSubmodule}`,
        );
      }
    }
  } else if (workUnitBenches.length > 0) {
    console.debug(
      `[auto-clear] Skipping ${workUnitBenches.length} work-unit bench(es) in project ${projectId} ` +
        `(workUnitAutoClear disabled)`,
    );
  }

  // --- Legacy benches: issue-based classification (Path 1 / Path 2) ---
  if (legacyBenches.length === 0) return;

  const repoFullName = config.project.repo;
  if (!repoFullName) return;

  // Track which benches still need a fallback check
  const needsFallback = new Set(legacyBenches.map((b) => b.id));

  // --- Path 1: project board status ---
  const projectNumber = config.project.github?.project;
  if (projectNumber != null) {
    let projectItems: Awaited<ReturnType<typeof githubService.fetchProjectItems>>;
    try {
      projectItems = await githubService.fetchProjectItems(repoFullName, projectNumber);
    } catch (err) {
      // GitHub unavailable or not configured: skip board check, fall through to per-issue check
      console.error(
        `[auto-clear] Could not fetch project items for ${repoFullName}#${projectNumber}:`,
        err,
      );
      projectItems = { items: [], projectTitle: "" };
    }

    const statusByIssueNumber = new Map(
      projectItems.items.map((item) => [item.issue.number, item.status]),
    );

    for (const bench of legacyBenches) {
      if (!bench.assignedIssue) continue;
      const issueNumber = bench.assignedIssue.number;
      if (issueNumber == null) continue;
      if (!statusByIssueNumber.has(issueNumber)) {
        // Not found in project items: may be closed; check via fallback
        continue;
      }
      const status = statusByIssueNumber.get(issueNumber);
      if (status != null && DONE_STATUSES.has(status.toLowerCase())) {
        needsFallback.delete(bench.id);
        console.log(
          `[auto-clear] Clearing bench ${bench.id} (project ${projectId}): ` +
            `issue #${issueNumber} status is "${status}" reason=legacy-issue-closed`,
        );
        try {
          await safeTeardown(projectId, bench);
        } catch (err) {
          console.error(`[auto-clear] Could not process bench ${bench.id}:`, err);
        }
      } else if (status != null) {
        // Issue found in board with a known non-done status: no need for fallback
        needsFallback.delete(bench.id);
      }
      // If status is null/undefined, leave bench in needsFallback for Path 2 to check
    }
  }

  // --- Path 2: issue state fallback (closed issues, no project board) ---
  const fallbackBenches = legacyBenches.filter((b) => needsFallback.has(b.id));

  await Promise.all(
    fallbackBenches.map(async (bench) => {
      if (!bench.assignedIssue) return;
      const issueNumber = bench.assignedIssue.number;
      if (issueNumber == null) return;
      try {
        const issue = await githubService.fetchIssueDetail(repoFullName, issueNumber);
        if (issue.state === "closed") {
          console.log(
            `[auto-clear] Clearing bench ${bench.id} (project ${projectId}): ` +
              `issue #${issueNumber} is closed reason=legacy-issue-closed`,
          );
          await safeTeardown(projectId, bench);
        }
      } catch (err) {
        console.error(
          `[auto-clear] Could not fetch issue #${issueNumber} for ${repoFullName}:`,
          err,
        );
      }
    }),
  );
}
