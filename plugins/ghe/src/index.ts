import { definePlugin, host } from "@roubo/plugin-sdk";
import { bindHost } from "./host-binding.js";
import { getAvailableTransitions } from "./methods/get-available-transitions.js";
import { getComments } from "./methods/get-comments.js";
import { getCurrentUser } from "./methods/get-current-user.js";
import { getIssue } from "./methods/get-issue.js";
import { listIssueTypes } from "./methods/list-issue-types.js";
import { listIssues } from "./methods/list-issues.js";
import { listLabels } from "./methods/list-labels.js";
import { listSourceCandidates } from "./methods/list-source-candidates.js";
import { validateConfig } from "./methods/validate-config.js";

bindHost(host);

definePlugin({
  listSourceCandidates,
  listIssues,
  getIssue,
  getComments,
  getCurrentUser,
  validateConfig,
  getAvailableTransitions,
  listIssueTypes,
  listLabels,
});
