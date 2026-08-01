import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import { Button, TextField, Input } from "react-aria-components";
import Spinner from "../Spinner";
import Select from "../Select";
import { useProjectPermissions } from "../../hooks/useProjectPermissions";
import { useProjects } from "../../hooks/useProjects";
import { useToast } from "../../hooks/useToast";
import { PermissionsRulesTable } from "./PermissionsRulesTable";
import {
  RULE_TYPE_ITEMS,
  flattenPermissions,
  type PermissionRule,
  type RuleType,
} from "./permissionsTable";
import { ImportPermissionsModal } from "./ImportPermissionsModal";
import type { ProjectPermissions } from "@roubo/shared";

interface ProjectPermissionsEditorPageProps {
  projectId: string;
}

const TEMPLATES = ["Bash(*)", "Read(./**)", "Edit(**/*.ts)", "WebFetch(domain:*)", "mcp__*"];

/**
 * The universal posture axis (AP-FR-016). One vocabulary for every agent; each
 * agent plugin maps it to its own native mechanism, so nothing here names a
 * product or a product's flag.
 */
const POSTURE_ITEMS = [
  { value: "", label: "Agent default" },
  { value: "read-only", label: "Read only" },
  { value: "guarded", label: "Ask before acting" },
  { value: "auto-edit", label: "Edit without asking" },
  { value: "full-auto", label: "Fully autonomous" },
];

const POSTURE_HINTS: Record<string, string> = {
  "": "Leave the agent on whatever its own configuration selects.",
  "read-only": "The agent may read and plan, but never edit or run commands.",
  guarded: "The agent asks before each edit or command.",
  "auto-edit": "The agent edits files without asking, but still asks to run commands.",
  "full-auto": "The agent edits and runs commands without asking.",
};

function unflattenPermissions(
  rules: PermissionRule[],
  posture: ProjectPermissions["posture"],
): ProjectPermissions {
  return {
    allow: rules.filter((r) => r.type === "allow").map((r) => r.pattern),
    deny: rules.filter((r) => r.type === "deny").map((r) => r.pattern),
    ask: rules.filter((r) => r.type === "ask").map((r) => r.pattern),
    ...(posture !== undefined && { posture }),
  };
}

export function ProjectPermissionsEditorPage({ projectId }: ProjectPermissionsEditorPageProps) {
  const {
    permissions,
    isLoading,
    updatePermissions,
    isError,
    error,
    resyncBenches,
    isResyncing,
    capabilities,
  } = useProjectPermissions(projectId);
  const { data: projects } = useProjects();
  const { addToast } = useToast();

  const [addType, setAddType] = useState<RuleType>("allow");
  const [addPattern, setAddPattern] = useState("");
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const currentPermissions: ProjectPermissions = permissions ?? { allow: [], deny: [], ask: [] };
  const rules = flattenPermissions(currentPermissions);
  const project = projects?.find((p) => p.id === projectId);

  // The two axes fail in opposite directions, deliberately. Rules fail OPEN:
  // absent capabilities (the probe has not answered yet, or it failed) keep the
  // rules editor visible, because hiding a control every pre-agent-plugin
  // project already had is worse than briefly showing one their agent ignores.
  // Posture fails CLOSED: it is a control this release introduces, and an empty
  // `postures` list is the server's own designed answer for an agent that
  // declares none (as does having no agent plugin at all), so it stays hidden until
  // the probe positively reports postures to offer.
  const showRules = capabilities?.rules !== false;
  const showResync = showRules && capabilities?.resync !== false;
  const showPosture = (capabilities?.postures.length ?? 0) > 0;
  const agentLabel = capabilities?.agentName ?? "your AI coding agent";

  const isDuplicateRule = (type: RuleType, pattern: string) =>
    (currentPermissions[type] ?? []).includes(pattern);

  const handleAdd = () => {
    const trimmed = addPattern.trim();
    if (!trimmed) return;
    if (isDuplicateRule(addType, trimmed)) {
      setIsDuplicate(true);
      return;
    }
    updatePermissions({
      ...currentPermissions,
      [addType]: [...(currentPermissions[addType] ?? []), trimmed],
    });
    setAddPattern("");
    setIsDuplicate(false);
  };

  const handlePatternChange = (value: string) => {
    setAddPattern(value);
    setIsDuplicate(false);
  };

  const handleRemove = (index: number) => {
    const updated = rules.filter((_, i) => i !== index);
    updatePermissions(unflattenPermissions(updated, currentPermissions.posture));
  };

  const handleEdit = (index: number, next: PermissionRule) => {
    const updated = [...rules];
    updated[index] = next;
    updatePermissions(unflattenPermissions(updated, currentPermissions.posture));
  };

  const handlePostureChange = (value: string) => {
    const next = value === "" ? undefined : (value as ProjectPermissions["posture"]);
    // Rebuilt rather than spread-and-override: clearing the posture has to drop
    // the key, and PUT replaces the whole set, so a leftover key would persist.
    updatePermissions(unflattenPermissions(rules, next));
  };

  const handleImport = (newRules: PermissionRule[]) => {
    const result = { ...currentPermissions };
    for (const rule of newRules) {
      const existing = result[rule.type] ?? [];
      if (!existing.includes(rule.pattern)) {
        result[rule.type] = [...existing, rule.pattern];
      }
    }
    updatePermissions(result);
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(currentPermissions, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const name = project?.repoPath.split("/").filter(Boolean).pop() ?? projectId;
    a.href = url;
    a.download = `${name}-agent-permissions.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleResync = () => {
    resyncBenches(undefined, {
      onSuccess: (result) => {
        const parts = [`Re-synced ${result.resynced} bench${result.resynced !== 1 ? "es" : ""}`];
        if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
        if (result.errors.length > 0)
          parts.push(`${result.errors.length} error${result.errors.length !== 1 ? "s" : ""}`);
        addToast(parts.join(" · "));
      },
      onError: (err) => {
        addToast(err instanceof Error ? err.message : "Re-sync failed", { duration: 8000 });
      },
    });
  };

  return (
    <div className="max-w-[1100px] w-full p-8 space-y-5">
      <div>
        <div className="flex items-center gap-2 text-[12px] text-stone-500 mb-5">
          <Link
            to=".."
            relative="path"
            className="inline-flex items-center gap-1 hover:text-stone-900 dark:hover:text-stone-200 transition-colors"
          >
            <ChevronLeft size={12} />
            Settings
          </Link>
          <span className="text-stone-400 dark:text-stone-600">/</span>
          <span className="text-stone-700 dark:text-stone-300">Agent permissions</span>
        </div>

        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="text-[18px] font-semibold text-stone-900 dark:text-stone-100">
              Agent permissions
            </h2>
            <p className="text-[12px] text-stone-400 dark:text-stone-500 mt-1 max-w-2xl leading-relaxed">
              How much {agentLabel} may do on its own in this project, and the fine-grained rules it
              works within. Roubo maps both onto whatever mechanism the agent uses. Changes apply to
              new benches immediately; existing benches can be re-synced.
            </p>
          </div>
          {showRules && (
            <div className="flex items-center gap-2 shrink-0 ml-4">
              <Button
                onPress={() => setShowImport(true)}
                className="text-[12px] px-3 py-1.5 rounded-md border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-400 dark:hover:border-stone-600 hover:text-stone-900 dark:hover:text-stone-100 outline-none transition-colors"
              >
                Import from project
              </Button>
              <Button
                onPress={handleExportJson}
                className="text-[12px] px-3 py-1.5 rounded-md border border-stone-300 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-400 dark:hover:border-stone-600 hover:text-stone-900 dark:hover:text-stone-100 outline-none transition-colors"
              >
                Export JSON
              </Button>
            </div>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600">
          <Spinner />
          Loading…
        </div>
      )}

      {!isLoading && showPosture && (
        <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-100 dark:bg-stone-900/40 p-4">
          <div className="text-[11px] text-stone-500 mb-2 font-medium">Posture</div>
          <div className="grid grid-cols-12 gap-2 items-center">
            <div className="col-span-4">
              <Select
                ariaLabel="Permission posture"
                items={POSTURE_ITEMS.filter(
                  (item) =>
                    item.value === "" ||
                    capabilities?.postures.includes(
                      item.value as NonNullable<ProjectPermissions["posture"]>,
                    ),
                )}
                value={currentPermissions.posture ?? ""}
                onChange={handlePostureChange}
              />
            </div>
            <p className="col-span-8 text-[11px] text-stone-500 dark:text-stone-500 leading-relaxed">
              {POSTURE_HINTS[currentPermissions.posture ?? ""]}
            </p>
          </div>
        </div>
      )}

      {!isLoading && showRules && (
        <>
          {/* Add rule container */}
          <div className="rounded-xl border border-stone-200 dark:border-stone-800 bg-stone-100 dark:bg-stone-900/40 p-4">
            <div className="text-[11px] text-stone-500 mb-2 font-medium">Add rule</div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-2">
                <Select
                  aria-label="Rule type"
                  items={RULE_TYPE_ITEMS}
                  value={addType}
                  onChange={(v) => {
                    setAddType(v as RuleType);
                    setIsDuplicate(false);
                  }}
                />
              </div>
              <div className="col-span-9">
                <TextField
                  aria-label="Rule pattern"
                  value={addPattern}
                  onChange={handlePatternChange}
                  isInvalid={isDuplicate}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAdd();
                  }}
                >
                  <Input
                    placeholder="Bash(pytest:*)"
                    className="w-full rounded-lg bg-stone-100 dark:bg-stone-800/60 border border-stone-300 dark:border-stone-700/50 px-3 py-2 text-[13px] text-stone-900 dark:text-stone-200 placeholder-stone-400 dark:placeholder-stone-600 focus:outline-none focus:ring-1 focus:ring-stone-400 dark:focus:ring-stone-600 font-mono data-[invalid]:border-red-400 dark:data-[invalid]:border-red-500"
                  />
                </TextField>
              </div>
              <div className="col-span-1">
                <Button
                  onPress={handleAdd}
                  isDisabled={!addPattern.trim()}
                  className="w-full px-3 py-2 rounded-md text-[12px] font-medium bg-amber-500 hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed text-stone-950 outline-none transition-colors"
                >
                  Add
                </Button>
              </div>
            </div>
            {isDuplicate && (
              <p className="mt-1.5 text-[11px] text-red-500 dark:text-red-400">
                Rule already exists
              </p>
            )}
            <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px] items-center">
              <span className="text-stone-500 dark:text-stone-600">Templates:</span>
              {TEMPLATES.map((tpl) => (
                <Button
                  key={tpl}
                  onPress={() => {
                    setAddPattern(tpl);
                    setIsDuplicate(false);
                  }}
                  className="font-mono text-[10px] px-1.5 py-0.5 rounded-sm bg-stone-200 dark:bg-stone-800 text-stone-600 dark:text-stone-400 border border-stone-300 dark:border-stone-700 hover:border-stone-400 dark:hover:border-stone-500 outline-none transition-colors"
                >
                  {tpl}
                </Button>
              ))}
            </div>
          </div>

          {/* Rules table */}
          <div>
            <PermissionsRulesTable
              rules={rules}
              editable
              emptyMessage="No rules yet. Add one above."
              onRemove={handleRemove}
              onEdit={handleEdit}
            />

            {/* Resync row: separate from the table card, no border-merge */}
            <div className="mt-3 flex items-center justify-between">
              <div className="text-[11px] text-stone-500">
                {rules.length > 0
                  ? `${rules.length} rule${rules.length !== 1 ? "s" : ""} · ${currentPermissions.allow.length} allow · ${currentPermissions.deny.length} deny · ${(currentPermissions.ask ?? []).length} ask`
                  : "No rules"}
              </div>
              {showResync && (
                <Button
                  onPress={handleResync}
                  isDisabled={isResyncing}
                  className="text-[11px] font-medium px-3 py-1.5 rounded-md bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-stone-950 outline-none transition-colors"
                >
                  {isResyncing ? "Resyncing…" : "Re-sync benches"}
                </Button>
              )}
            </div>
          </div>

          <p className="text-[11px] text-stone-500 dark:text-stone-600 leading-relaxed">
            Re-syncing adds any missing rules to existing benches. Removed rules take effect when a
            bench is cleared.
          </p>
        </>
      )}

      {/* Load and save failures are reported by `mutation.isError || query.isError`,
          neither of which is tied to the rules axis, so the banner sits outside the
          rules fragment: an agent that declares `rules: false` can still fail a
          posture PUT or a permissions GET. */}
      {!isLoading && isError && (
        <p className="text-sm text-red-500 dark:text-red-400">
          {error instanceof Error && /rejected because/.test(error.message)
            ? error.message
            : "Failed to load or save permissions. Please try again."}
        </p>
      )}

      {/* An agent that declares no permissions capability at all reports both
          `postures: []` and `rules: false`, so there is no posture control above
          to point the reader at. Name only the axes actually on screen. */}
      {!isLoading && !showRules && (
        <p className="text-[12px] text-stone-500 dark:text-stone-500 leading-relaxed">
          {showPosture
            ? `${agentLabel} does not support fine-grained permission rules, so only the posture above applies to this project.`
            : `${agentLabel} does not expose any permission settings Roubo can manage for this project.`}
        </p>
      )}

      <ImportPermissionsModal
        isOpen={showImport}
        onClose={() => setShowImport(false)}
        currentProjectId={projectId}
        currentPermissions={currentPermissions}
        onImport={handleImport}
      />
    </div>
  );
}
