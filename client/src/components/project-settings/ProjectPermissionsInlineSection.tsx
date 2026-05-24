import Spinner from "../Spinner";
import { useProjectPermissions } from "../../hooks/useProjectPermissions";
import { PermissionsRulesTable } from "./PermissionsRulesTable";
import { flattenPermissions } from "./permissionsTable";

interface ProjectPermissionsInlineSectionProps {
  projectId: string;
}

export function ProjectPermissionsInlineSection({
  projectId,
}: ProjectPermissionsInlineSectionProps) {
  const { permissions, isLoading, isError } = useProjectPermissions(projectId);

  const allow = permissions?.allow ?? [];
  const deny = permissions?.deny ?? [];
  const ask = permissions?.ask ?? [];
  const hasRules = allow.length > 0 || deny.length > 0 || ask.length > 0;
  const total = allow.length + deny.length + ask.length;

  return (
    <div>
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600">
          <Spinner />
          Loading…
        </div>
      )}

      {!isLoading && isError && (
        <p className="text-xs text-red-500 dark:text-red-400 leading-relaxed">
          Could not load permissions.
        </p>
      )}

      {!isLoading && !isError && (
        <>
          <PermissionsRulesTable
            rules={hasRules ? flattenPermissions({ allow, deny, ask }) : []}
            editable={false}
            emptyMessage="No permissions saved. Rules granted in Claude Code sessions appear here automatically."
          />
          {hasRules && (
            <p className="mt-2 text-[11px] text-stone-500 dark:text-stone-500">
              {total} rule{total !== 1 ? "s" : ""} · {allow.length} allow · {deny.length} deny ·{" "}
              {ask.length} ask
            </p>
          )}
        </>
      )}
    </div>
  );
}
