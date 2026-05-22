import type { SourceCandidate } from "@roubo/plugin-sdk";
import { fetchCurrentUser, fetchProjects, fetchUserRepos } from "../github-fetchers.js";

/**
 * Returns the repos the current user can see plus all GitHub Projects v2
 * for the user's own login (projects scoped to organizations the user
 * belongs to are deferred to a follow-up: the legacy module only ever
 * looked up projects for the explicit owner of the configured repo).
 */
export async function listSourceCandidates(): Promise<SourceCandidate[]> {
  const candidates: SourceCandidate[] = [];

  const repos = await fetchUserRepos();
  for (const repo of repos) {
    candidates.push({
      category: "Repository",
      externalId: repo.full_name,
      displayName: repo.full_name,
      ...(repo.description ? { description: repo.description } : {}),
    });
  }

  try {
    const user = await fetchCurrentUser();
    const projects = await fetchProjects(user.login);
    for (const project of projects) {
      candidates.push({
        category: "Project",
        externalId: `${user.login}/#${project.number}`,
        displayName: `${project.title} (#${project.number})`,
        description: `GitHub Project v2 owned by ${user.login}`,
      });
    }
  } catch (err) {
    // Listing projects is best-effort: a missing read:project scope or no
    // projects at all should not break the broader candidate list.
    console.warn(
      "[github-com] listSourceCandidates: failed to enumerate user projects:",
      (err as Error).message,
    );
  }

  return candidates;
}
