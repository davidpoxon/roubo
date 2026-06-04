export type JigVariableCategory = "issue" | "bench" | "project" | "config";

export interface JigVariable {
  syntax: string;
  category: JigVariableCategory;
  description: string;
  example?: string;
  note?: string;
}

export interface JigVariableGroup {
  category: JigVariableCategory;
  label: string;
  items: JigVariable[];
  footnote?: string;
}

const ISSUE_VARS: JigVariable[] = [
  {
    syntax: "{{issueNumber}}",
    category: "issue",
    description: "GitHub issue number",
    example: "42",
  },
  {
    syntax: "{{issueTitle}}",
    category: "issue",
    description: "GitHub issue title",
    example: "Fix login bug",
  },
  {
    syntax: "{{issueBody}}",
    category: "issue",
    description: "GitHub issue body (formatted markdown)",
  },
  {
    syntax: "{{issueUrl}}",
    category: "issue",
    description: "URL to the GitHub issue",
    example: "https://github.com/org/repo/issues/42",
  },
  {
    syntax: "{{comments}}",
    category: "issue",
    description: "Formatted issue comment thread",
    note: "Only present when an issue is assigned to the bench",
  },
];

const BENCH_VARS: JigVariable[] = [
  {
    syntax: "{{bench.id}}",
    category: "bench",
    description: "Numeric bench identifier",
    example: "1",
  },
  {
    syntax: "{{bench.branch}}",
    category: "bench",
    description: "Git branch name for this bench",
    example: "feature/my-change",
  },
];

const PROJECT_VARS: JigVariable[] = [
  {
    syntax: "{{project.name}}",
    category: "project",
    description: "Display name of the project",
    example: "my-app",
  },
];

const CONFIG_VARS_GLOBAL: JigVariable[] = [
  {
    syntax: "{{workspace}}",
    category: "config",
    description: "Absolute path to the bench's git workspace",
    example: "~/.roubo/workspaces/my-app/bench-1",
  },
  {
    syntax: "{{ports.<component>}}",
    category: "config",
    description: "Allocated port for a named component (e.g. server, client)",
  },
  {
    syntax: "{{urls.<component>}}",
    category: "config",
    description: "Full URL for a named component (e.g. http://localhost:4100)",
  },
  {
    syntax: "{{components.<name>.connection}}",
    category: "config",
    description: "Connection string for a named component",
  },
];

const CONFIG_FOOTNOTE_GLOBAL =
  "Config placeholders are inserted literally; they resolve against the active project when the jig is injected.";

export function getJigVariableGroups(scope: "global" | "project"): JigVariableGroup[] {
  const configFootnote = scope === "global" ? CONFIG_FOOTNOTE_GLOBAL : undefined;

  return [
    { category: "issue", label: "Issue", items: ISSUE_VARS },
    { category: "bench", label: "Bench", items: BENCH_VARS },
    { category: "project", label: "Project", items: PROJECT_VARS },
    { category: "config", label: "Config", items: CONFIG_VARS_GLOBAL, footnote: configFootnote },
  ];
}
