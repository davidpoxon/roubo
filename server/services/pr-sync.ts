import type { Bench, TrackedPullRequest, RegisteredProject } from "@roubo/shared";
import * as benchManager from "./bench-manager.js";
import * as projectRegistry from "./project-registry.js";
import * as githubService from "./github.js";
import * as notificationService from "./notification.js";
import { toPersistedBench, updateBench } from "./state.js";
import { resolveRepoFullName, probeWorkUnitState } from "./git-helpers.js";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

type FetchCache = Map<string, ReturnType<typeof githubService.fetchOpenPullRequestByBranch>>;

/**
 * Syncs PR state for all work units of a single bench. Persists any changes.
 * Safe to call concurrently with the auto-clear tick: the sync is idempotent
 * (fetches from GitHub, writes state fields).
 */
export async function syncBenchWorkUnitPRs(projectId: string, bench: Bench): Promise<void> {
  if (!githubService.getGithubToken()) return;

  const project = projectRegistry.getProject(projectId);
  if (!project?.config) return;

  const fetchCache: FetchCache = new Map();
  await syncBenchWorkUnits(project, bench, fetchCache);
}

/**
 * Syncs PR state for every meta-repo bench across all projects. Results are
 * deduped by {repoFullName, branch} within a call so shared submodule branches
 * produce a single GitHub request. Used by the auto-clear tick.
 */
export async function syncAllWorkUnitPRs(byProject: Map<string, Bench[]>): Promise<void> {
  if (!githubService.getGithubToken()) return;

  // Per-call dedup: repoFullName\0branch → Promise of fetch result.
  const fetchCache: FetchCache = new Map();

  for (const [projectId, benches] of byProject) {
    const project = projectRegistry.getProject(projectId);
    if (!project?.config) continue;

    const metaBenches = benches.filter((b) => b.workUnits && b.workUnits.length > 0);
    for (const bench of metaBenches) {
      await syncBenchWorkUnits(project, bench, fetchCache);
    }
  }
}

async function syncBenchWorkUnits(
  project: RegisteredProject,
  bench: Bench,
  fetchCache: FetchCache,
): Promise<void> {
  if (!project.config) return;

  let benchDirty = false;

  for (const workUnit of bench.workUnits ?? []) {
    try {
      // ── Step 1: Refresh branch from HEAD and probe filesystem activity ──
      // Run for all work units so dirty state is always up-to-date. The "."
      // root work unit only gets a dirty probe: its branch is owned by bench.branch.
      const probe = await probeWorkUnitState(workUnit.workspacePath);

      // Update dirty state (always, for all work units including ".")
      workUnit.dirtyState = probe.dirty;
      benchDirty = true;

      if (workUnit.submodule !== ".") {
        if (probe.branch !== null) {
          // Submodule HEAD is on a real branch: update and clear detached flag
          if (probe.branch !== workUnit.branch) {
            workUnit.branch = probe.branch;
          }
          workUnit.detached = false;
        } else {
          // Detached HEAD: record it; preserve last-known branch for display continuity
          workUnit.detached = true;
        }
      }

      // ── Step 2: Resolve the GitHub owner/repo for this work unit ──
      let repoFullName: string | null;
      if (workUnit.submodule === ".") {
        repoFullName = project.config.project.repo ?? null;
      } else {
        repoFullName = await resolveRepoFullName(workUnit.workspacePath);
      }

      if (!repoFullName) {
        workUnit.syncError = `Could not resolve repoFullName for submodule "${workUnit.submodule}" (workspacePath: "${workUnit.workspacePath}")`;
        console.error(`[pr-sync] ${workUnit.syncError} (bench ${bench.id})`);
        notificationService.createNotification(
          bench,
          "sync-error",
          `sync-error::${workUnit.submodule}`,
          {
            submodule: workUnit.submodule,
            error: workUnit.syncError,
          },
        );
        // Still set lastSyncedAt so the chip shows freshness even on error
        workUnit.lastSyncedAt = new Date().toISOString();
        continue;
      }

      // ── Step 3: Skip PR fetch for detached-HEAD submodules ──
      // A detached HEAD has no branch ref to query against. Clear any stale PR
      // that has aged out and record the sync time so the chip stays fresh.
      if (workUnit.detached) {
        const prev = workUnit.pullRequest;
        if (prev && Date.now() - new Date(prev.updatedAt).getTime() >= TWENTY_FOUR_HOURS_MS) {
          workUnit.pullRequest = undefined;
        }
        workUnit.lastSyncedAt = new Date().toISOString();
        workUnit.syncError = undefined;
        notificationService.dismissSyncErrorForWorkUnit(bench, workUnit.submodule);
        continue;
      }

      // ── Step 4: Dedup: one request per {repoFullName, branch} per call ──
      const key = `${repoFullName}\0${workUnit.branch}`;
      let fetchPromise = fetchCache.get(key);
      if (!fetchPromise) {
        fetchPromise = githubService.fetchOpenPullRequestByBranch(repoFullName, workUnit.branch);
        fetchCache.set(key, fetchPromise);
      }

      const { notModified, pr } = await fetchPromise;

      // ETag 304: nothing changed; skip all state writes
      if (notModified) continue;

      if (pr) {
        // Open PR found: update tracked state
        const tracked: TrackedPullRequest = {
          repoFullName,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          merged: pr.merged,
          url: pr.url,
          updatedAt: pr.updatedAt,
        };
        workUnit.pullRequest = tracked;
        workUnit.lastSyncedAt = new Date().toISOString();
        workUnit.syncError = undefined;
        notificationService.dismissSyncErrorForWorkUnit(bench, workUnit.submodule);
      } else {
        // No open PR: check if we had a previous PR that may have transitioned
        const prev = workUnit.pullRequest;
        if (prev && Date.now() - new Date(prev.updatedAt).getTime() < TWENTY_FOUR_HOURS_MS) {
          // Previous PR was recently active: fetch direct detail to detect merged/closed
          try {
            const detail = await githubService.fetchPullRequestDetail(repoFullName, prev.number);
            workUnit.pullRequest = {
              repoFullName,
              number: detail.number,
              title: detail.title,
              state: detail.state,
              merged: detail.merged,
              url: detail.url,
              updatedAt: detail.updatedAt,
            };
            workUnit.lastSyncedAt = new Date().toISOString();
            workUnit.syncError = undefined;
            notificationService.dismissSyncErrorForWorkUnit(bench, workUnit.submodule);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            workUnit.syncError = msg;
            console.error(
              `[pr-sync] PR detail fetch failed for bench ${bench.id} submodule "${workUnit.submodule}": ${msg}`,
            );
            notificationService.createNotification(
              bench,
              "sync-error",
              `sync-error::${workUnit.submodule}`,
              {
                submodule: workUnit.submodule,
                error: msg,
              },
            );
          }
        } else {
          // No recent previous PR: clear tracked state
          workUnit.pullRequest = undefined;
          workUnit.lastSyncedAt = new Date().toISOString();
          workUnit.syncError = undefined;
          notificationService.dismissSyncErrorForWorkUnit(bench, workUnit.submodule);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      workUnit.syncError = msg;
      console.error(
        `[pr-sync] PR sync failed for bench ${bench.id} submodule "${workUnit.submodule}": ${msg}`,
      );
      notificationService.createNotification(
        bench,
        "sync-error",
        `sync-error::${workUnit.submodule}`,
        {
          submodule: workUnit.submodule,
          error: msg,
        },
      );
      benchDirty = true;
    }
  }

  // Only persist if the bench is still tracked. This sync holds the bench
  // reference across awaited GitHub calls; if a teardown cleared the bench in
  // that window (removeBench + benches.delete), persisting here would resurrect
  // it in state.json and it would reappear on the next app restart.
  if (benchDirty && benchManager.isBenchLive(bench.projectId, bench.id)) {
    updateBench(toPersistedBench(bench));
  }
}
