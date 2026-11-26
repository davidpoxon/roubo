// The stale marks a project re-path leaves on the project's benches
// (HR-FR-014). A bench set up before its project moved keeps the workspace it
// was set up in, a worktree of the old checkout, so it reads stale until it is
// cleared. The registry sets the marks and the bench serialiser reads them.
//
// It lives apart from project-registry and bench-manager so both, and the
// serialiser, can read it without importing each other. The marks are kept in
// memory only: a relaunch reads every bench from state.json afresh.

function benchKey(projectId: string, benchId: number): string {
  return JSON.stringify([projectId, benchId]);
}

const marked = new Set<string>();

/** Marks each of `benchIds` of `projectId` stale after a re-path of the project. */
export function markBenchesRepathed(projectId: string, benchIds: Iterable<number>): void {
  for (const benchId of benchIds) marked.add(benchKey(projectId, benchId));
}

/** Whether a re-path of its project left the bench stale. */
export function isBenchStaleFromRepath(projectId: string, benchId: number): boolean {
  return marked.has(benchKey(projectId, benchId));
}

/**
 * Drops the mark of one bench: the bench was cleared, so a bench set up later
 * with the same number is set up at the project's current path.
 */
export function clearBenchRepathed(projectId: string, benchId: number): void {
  marked.delete(benchKey(projectId, benchId));
}

/** Drops the mark of every bench of a project, when the project is unregistered. */
export function clearProjectRepathed(projectId: string): void {
  for (const key of [...marked]) {
    if ((JSON.parse(key) as [string, number])[0] === projectId) marked.delete(key);
  }
}

/** Test-only: forget every mark. */
export function resetForTests(): void {
  marked.clear();
}
