import { useState } from "react";
import { Link } from "react-router";
import { ChevronLeft } from "lucide-react";
import { Button, TextField, Input } from "react-aria-components";
import Spinner from "../Spinner";
import Select from "../Select";
import { useProjectPermissions } from "../../hooks/useProjectPermissions";
import { useProjects } from "../../hooks/useProjects";
import { useToast } from "../../hooks/useToast";
import { PermissionsRulesTable } from "./PermissionsRulesTable";
import {
  ALL_RULE_TYPES,
  flattenPermissions,
  ruleTypeItemsFor,
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

/**
 * "ask", or "deny or ask", for prose that names the tiers an agent drops. The
 * list reads as alternatives rather than a conjunction because the sentence it
 * sits in is about one rule at a time: a rule is marked deny OR ask, never both.
 */
function listTiers(tiers: RuleType[]): string {
  if (tiers.length <= 1) return tiers.join("");
  return `${tiers.slice(0, -1).join(", ")} or ${tiers[tiers.length - 1]}`;
}

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
  //
  // The tiers inside the rules axis fail open for the same reason rules do: an
  // agent that declares nothing carries all three, so an unanswered probe must
  // not quietly take a tier away from a project that already uses it (#862).
  const showRules = capabilities?.rules !== false;
  const showResync = showRules && capabilities?.resync !== false;
  const showPosture = (capabilities?.postures.length ?? 0) > 0;
  const agentLabel = capabilities?.agentName ?? "your AI coding agent";
  const honouredTiers = capabilities?.ruleTiers ?? ALL_RULE_TYPES;
  const addTypeItems = ruleTypeItemsFor(honouredTiers);
  // A tier the agent cannot carry is dropped on the way to the workspace, so the
  // screen offers no way to create one and says what happens to any already
  // stored. Naming the tiers rather than assuming `ask` keeps this agnostic: a
  // future agent may drop a different one.
  const droppedTiers = ALL_RULE_TYPES.filter((tier) => !honouredTiers.includes(tier));
  // A dropped tier is listed only when the project actually has rules in it, and
  // then never without saying it is not applied.
  const tierSummary = ALL_RULE_TYPES.map((tier) => ({
    tier,
    count: (currentPermissions[tier] ?? []).length,
  }))
    .filter(({ tier, count }) => honouredTiers.includes(tier) || count > 0)
    .map(
      ({ tier, count }) =>
        `${count} ${tier}${honouredTiers.includes(tier) ? "" : " (not applied)"}`,
    )
    .join(" · ");
  // Never leave the composer sitting on a tier it cannot create.
  const effectiveAddType = honouredTiers.includes(addType)
    ? addType
    : ((addTypeItems[0]?.value ?? addType) as RuleType);

  const isDuplicateRule = (type: RuleType, pattern: string) =>
    (currentPermissions[type] ?? []).includes(pattern);

  const handleAdd = () => {
    const trimmed = addPattern.trim();
    if (!trimmed) return;
    if (isDuplicateRule(effectiveAddType, trimmed)) {
      setIsDuplicate(true);
      return;
    }
    updatePermissions({
      ...currentPermissions,
      [effectiveAddType]: [...(currentPermissions[effectiveAddType] ?? []), trimmed],
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
        <div className="flex items-center gap-2 text-12 text-text-secondary mb-5">
          <Link
            to=".."
            relative="path"
            className="inline-flex items-center gap-1 hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <ChevronLeft size={12} />
            Settings
          </Link>
          <span className="text-text-secondary">/</span>
          <span className="text-text-primary">Agent permissions</span>
        </div>

        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="text-20 font-semibold text-text-primary">Agent permissions</h2>
            <p className="text-12 text-text-secondary mt-1 max-w-2xl leading-relaxed">
              How much {agentLabel} may do on its own in this project, and the fine-grained rules it
              works within. Roubo maps both onto whatever mechanism the agent uses. Changes apply to
              new benches immediately; existing benches can be re-synced.
            </p>
          </div>
          {showRules && (
            <div className="flex items-center gap-2 shrink-0 ml-4">
              <Button
                onPress={() => setShowImport(true)}
                className="text-12 px-3 py-1.5 rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Import from project
              </Button>
              <Button
                onPress={handleExportJson}
                className="text-12 px-3 py-1.5 rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Export JSON
              </Button>
            </div>
          )}
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-12 text-text-secondary">
          <Spinner />
          Loading…
        </div>
      )}

      {!isLoading && showPosture && (
        <div className="rounded-xl border border-border bg-bg-surface p-4">
          <div className="text-11 text-text-secondary mb-2 font-medium">Posture</div>
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
            <p className="col-span-8 text-11 text-text-secondary leading-relaxed">
              {POSTURE_HINTS[currentPermissions.posture ?? ""]}
            </p>
          </div>
        </div>
      )}

      {!isLoading && showRules && (
        <>
          {/* Add rule container */}
          <div className="rounded-xl border border-border bg-bg-surface p-4">
            <div className="text-11 text-text-secondary mb-2 font-medium">Add rule</div>
            <div className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-2">
                <Select
                  ariaLabel="Rule type"
                  items={addTypeItems}
                  value={effectiveAddType}
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
                    className="w-full rounded-control bg-bg-field border border-border-control px-3 py-2 text-13 text-text-primary placeholder:text-text-secondary outline-none focus:ring-2 focus:ring-focus-ring font-mono focus:border-focus-ring aria-[invalid=true]:border-danger data-[invalid]:border-danger"
                  />
                </TextField>
              </div>
              <div className="col-span-1">
                <Button
                  onPress={handleAdd}
                  isDisabled={!addPattern.trim()}
                  className="w-full px-3 py-2 rounded-control text-12 font-medium bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-on-accent outline-none transition-colors not-disabled:active:bg-accent-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  Add
                </Button>
              </div>
            </div>
            {isDuplicate && <p className="mt-1.5 text-11 text-danger-text">Rule already exists</p>}
            <div className="mt-2.5 flex flex-wrap gap-1.5 text-11 items-center">
              <span className="text-text-secondary">Templates:</span>
              {TEMPLATES.map((tpl) => (
                <Button
                  key={tpl}
                  onPress={() => {
                    setAddPattern(tpl);
                    setIsDuplicate(false);
                  }}
                  className="font-mono text-11 px-1.5 py-0.5 rounded-control bg-bg-hover text-text-secondary border border-border-strong hover:bg-bg-pressed hover:text-text-body outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {tpl}
                </Button>
              ))}
            </div>
          </div>

          {/* A tier this agent cannot carry is dropped on the way to the bench,
              so say so rather than letting a saved rule look applied. */}
          {droppedTiers.length > 0 && (
            <div className="rounded-xl border border-border bg-bg-base px-4 py-3 text-12 text-text-secondary leading-relaxed">
              {agentLabel} has no {listTiers(droppedTiers)} tier
              {droppedTiers.length > 1 ? "s" : ""}, so a rule marked {listTiers(droppedTiers)} is
              never written for this project and is not offered above. Any already saved stays
              listed below, marked as not applied, until you remove it.
            </div>
          )}

          {/* Rules table */}
          <div>
            <PermissionsRulesTable
              rules={rules}
              editable
              emptyMessage="No rules yet. Add one above."
              onRemove={handleRemove}
              onEdit={handleEdit}
              tiers={honouredTiers}
            />

            {/* Resync row: separate from the table card, no border-merge */}
            <div className="mt-3 flex items-center justify-between">
              <div className="text-11 text-text-secondary">
                {rules.length > 0
                  ? `${rules.length} rule${rules.length !== 1 ? "s" : ""} · ${tierSummary}`
                  : "No rules"}
              </div>
              {showResync && (
                <Button
                  onPress={handleResync}
                  isDisabled={isResyncing}
                  className="text-11 font-medium px-3 py-1.5 rounded-control bg-accent not-disabled:hover:bg-accent-hover disabled:opacity-40 text-on-accent outline-none transition-colors not-disabled:active:bg-accent-active focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {isResyncing ? "Resyncing…" : "Re-sync benches"}
                </Button>
              )}
            </div>
          </div>

          <p className="text-11 text-text-secondary leading-relaxed">
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
        <p className="text-13 text-danger-text">
          {error instanceof Error && /rejected because/.test(error.message)
            ? error.message
            : "Failed to load or save permissions. Please try again."}
        </p>
      )}

      {/* An agent that declares no permissions capability at all reports both
          `postures: []` and `rules: false`, so there is no posture control above
          to point the reader at. Name only the axes actually on screen. */}
      {!isLoading && !showRules && (
        <p className="text-12 text-text-secondary leading-relaxed">
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
        tiers={honouredTiers}
      />
    </div>
  );
}
