import { GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";
import type { BlueprintDetail } from "@roubo/shared";

const CONTENT = `You are working on **{{project.name}}** on branch \`{{bench.branch}}\`.

Workspace: \`{{workspace}}\`

## Task

Issue #{{issueNumber}}: {{issueTitle}}
{{issueUrl}}

{{issueBody}}

{{comments}}

Please review the codebase and implement the required changes. Follow existing code conventions, run tests to verify your work, and keep changes minimal and focused on the task.
`;

const CONTENT_SIZE = Buffer.byteLength(CONTENT, "utf-8");

const GLOBAL_DEFAULT_BLUEPRINT: BlueprintDetail = {
  id: GLOBAL_DEFAULT_BLUEPRINT_ID,
  name: "Default",
  description: "General-purpose Claude Code workflow",
  icon: "sparkles",
  source: "app",
  content: CONTENT,
  sizeBytes: CONTENT_SIZE,
  sizeWarning: false,
  approxTokens: Math.ceil(CONTENT_SIZE / 4),
};

export function cloneGlobalDefault(): BlueprintDetail {
  return { ...GLOBAL_DEFAULT_BLUEPRINT };
}
