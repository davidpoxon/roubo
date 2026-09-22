import Spinner from "../Spinner";
import { useProjectPermissions } from "../../hooks/useProjectPermissions";
import { PermissionsRulesTable } from "./PermissionsRulesTable";
import { ALL_RULE_TYPES, flattenPermissions } from "./permissionsTable";

interface ProjectPermissionsInlineSectionProps {
  projectId: string;
}

export function ProjectPermissionsInlineSection({
  projectId,
}: ProjectPermissionsInlineSectionProps) {
  const { permissions, isLoading, isError, capabilities } = useProjectPermissions(projectId);

  const allow = permissions?.allow ?? [];
  const deny = permissions?.deny ?? [];
  const ask = permissions?.ask ?? [];
  const hasRules = allow.length > 0 || deny.length > 0 || ask.length > 0;
  const total = allow.length + deny.length + ask.length;
  // Same fail-open default as the editor page: an agent that declares nothing,
  // and a probe that has not answered, carry every tier (#1345).
  const honouredTiers = capabilities?.ruleTiers ?? ALL_RULE_TYPES;
  const counts = { allow: allow.length, deny: deny.length, ask: ask.length };
  const tierSummary = ALL_RULE_TYPES.filter(
    (tier) => honouredTiers.includes(tier) || counts[tier] > 0,
  )
    .map((tier) => `${counts[tier]} ${tier}${honouredTiers.includes(tier) ? "" : " (not applied)"}`)
    .join(" · ");

  return (
    <div>
      {isLoading && (
        <div className="flex items-center gap-2 text-12 text-text-secondary">
          <Spinner />
          Loading…
        </div>
      )}

      {!isLoading && isError && (
        <p className="text-12 text-danger-text leading-relaxed">Could not load permissions.</p>
      )}

      {!isLoading && !isError && (
        <>
          <PermissionsRulesTable
            rules={hasRules ? flattenPermissions({ allow, deny, ask }) : []}
            editable={false}
            emptyMessage="No permissions saved. Rules granted in agent sessions appear here automatically."
            tiers={honouredTiers}
          />
          {hasRules && (
            <p className="mt-2 text-11 text-text-secondary">
              {total} rule{total !== 1 ? "s" : ""} · {tierSummary}
            </p>
          )}
        </>
      )}
    </div>
  );
}
