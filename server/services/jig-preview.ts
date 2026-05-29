import type { RegisteredProject, Bench } from "@roubo/shared";
import { buildTemplateContext, applyContainerOverrides } from "./config-parser.js";
import { fetchIssueContext } from "./issue-formatting.js";
import type { JigResolveContext } from "./jig-manager.js";

export function getSampleResolveContext(): JigResolveContext {
  return {
    ports: { server: 3000, client: 3001 },
    portHttps: { server: false, client: false },
    workspace: "~/.roubo/workspaces/my-app/bench-1",
    components: {},
    benchId: 1,
    benchBranch: "feature/my-change",
    projectName: "my-app",
    issueNumber: 42,
    issueTitle: "Fix login bug",
    issueBody: "This is a sample issue body.",
    issueUrl: "https://github.com/org/repo/issues/42",
    comments: "",
  };
}

export async function buildPreviewContext(
  project: RegisteredProject,
  bench: Bench,
): Promise<JigResolveContext> {
  if (!project.config) return getSampleResolveContext();

  const templateCtx = buildTemplateContext(project.config, bench.id, bench.workspacePath);
  applyContainerOverrides(templateCtx, bench.assignedContainers);

  let issueCtx: Partial<JigResolveContext> = {};

  // Alert-backed benches re-hydrate by alert number here and degrade to minimal
  // data; re-hydrating from the persisted redacted raw is deferred to #290.
  if (bench.assignedIssue && project.config.project.repo) {
    try {
      issueCtx = await fetchIssueContext(project.config.project.repo, bench.assignedIssue.number);
    } catch {
      issueCtx = {
        issueNumber: bench.assignedIssue.number,
        issueTitle: bench.assignedIssue.title,
      };
    }
  }

  // issueCtx must spread last: GitHub-fetched data is authoritative over
  // any locally-persisted issue fields that templateCtx may carry.
  return {
    ...templateCtx,
    benchBranch: bench.branch,
    benchId: bench.id,
    projectName: project.config.project.displayName,
    ...issueCtx,
  };
}

export function findUnresolvedVariables(resolved: string): string[] {
  const pattern = /\{\{[^}]+\}\}/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(resolved)) !== null) {
    found.add(match[0]);
  }
  return Array.from(found);
}
