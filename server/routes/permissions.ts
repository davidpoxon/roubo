import { Router } from "express";
import { getProjectPermissions, setProjectPermissions } from "../services/state.js";
import { getBenches } from "../services/bench-manager.js";
import * as projectRegistry from "../services/project-registry.js";
import {
  applyProjectPermissions,
  describeAgentPermissions,
} from "../services/agent-permissions.js";
import { assertSafeRules, PermissionRuleError } from "../services/permission-rule-guard.js";
import { AgentPostureSchema } from "@roubo/shared/agent-launch-descriptor-schema";
import type { PermissionsResyncResult, ProjectPermissions } from "@roubo/shared";

// Per-project agent permissions API (AP-FR-016, AP-FR-018, issue #514).
//
// One agent-generic model with two axes, mapped to each agent's native
// mechanism by that agent's plugin rather than here: the universal `posture`
// and the fine-grained allow/ask/deny rule strings. These routes store, guard,
// and dispatch; they never parse a rule's vocabulary, so nothing Claude-specific
// (or Codex-specific) reaches the wire types.

const router = Router();

router.get("/:projectId/permissions", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const permissions = getProjectPermissions(req.params.projectId);
  res.json(permissions);
});

/**
 * What the project's agent honours, so the editor can hide the axes that agent
 * ignores. Probing asks the resolved plugin for its descriptor, so a plugin that
 * is not installed, not consented, or not running degrades to a 200 describing
 * the built-in carrier rather than failing the screen.
 */
router.get("/:projectId/permissions/capabilities", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  void describeAgentPermissions(req.params.projectId, project.repoPath)
    .then((capabilities) => res.json(capabilities))
    .catch(() =>
      res.json({
        agentPluginId: null,
        agentName: null,
        postures: [],
        rules: true,
        resync: true,
      }),
    );
});

router.put("/:projectId/permissions", (req, res) => {
  const project = projectRegistry.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const body = req.body as Partial<ProjectPermissions>;
  const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) &&
    v.length <= 100 &&
    v.every((item) => typeof item === "string" && item.length <= 512);
  // allow, deny, and ask are optional; omitted fields default to [].
  if (
    (body?.allow !== undefined && !isStringArray(body.allow)) ||
    (body?.deny !== undefined && !isStringArray(body.deny)) ||
    (body?.ask !== undefined && !isStringArray(body.ask))
  ) {
    res.status(400).json({
      error:
        "Invalid body: allow, deny, and ask must be arrays of strings (max 100 items, 512 chars each)",
    });
    return;
  }

  // `posture` is optional and, when absent, stays absent: a project that has
  // never chosen one must leave the agent on whatever its own config selected.
  let posture: ProjectPermissions["posture"];
  if (body?.posture !== undefined && body.posture !== null) {
    const parsed = AgentPostureSchema.safeParse(body.posture);
    if (!parsed.success) {
      res.status(400).json({
        error: `Invalid body: posture must be one of ${AgentPostureSchema.options.join(", ")}`,
      });
      return;
    }
    posture = parsed.data;
  }

  // AP-TC-081: a pattern that names a path outside the bench workspace is
  // rejected at the point it is added, not quietly stored and injected later.
  // Only the access-granting groups are checked: a `deny` rule naming an
  // outside path forbids reach rather than granting it, so guarding it would
  // remove the user's only way to write that guardrail down.
  try {
    assertSafeRules({ allow: body?.allow, ask: body?.ask });
  } catch (err) {
    if (err instanceof PermissionRuleError) {
      res.status(400).json({ error: err.message, rule: err.rule });
      return;
    }
    throw err;
  }

  const permissions: ProjectPermissions = {
    allow: body?.allow ?? [],
    deny: body?.deny ?? [],
    ask: body?.ask ?? [],
    ...(posture !== undefined && { posture }),
  };
  try {
    setProjectPermissions(req.params.projectId, permissions);
    res.json(permissions);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/:projectId/permissions/resync", (req, res) => {
  const projectId = req.params.projectId;
  const project = projectRegistry.getProject(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const permissions = getProjectPermissions(projectId);
  const benches = getBenches(projectId);

  const result: PermissionsResyncResult = { resynced: 0, skipped: 0, errors: [] };

  const run = async () => {
    for (const bench of benches) {
      // A bench with no workspace, or one mid-teardown, has nothing safe to
      // write into: skip it without an error (AP-TC-080).
      if (!bench.workspacePath || bench.status === "clearing") {
        result.skipped++;
        continue;
      }
      try {
        const applied = await applyProjectPermissions({
          projectId,
          benchId: bench.id,
          workspacePath: bench.workspacePath,
          permissions,
        });
        // An agent that carries no rules is not an error, just nothing to do.
        if (applied.carrier === "none") result.skipped++;
        else result.resynced++;
      } catch (err) {
        result.errors.push({ benchId: bench.id, message: (err as Error).message });
      }
    }
  };

  void run().then(() => res.json(result));
});

export default router;
