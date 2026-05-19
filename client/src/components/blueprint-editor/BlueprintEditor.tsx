import { useParams, useNavigate } from "react-router-dom";
import { Button } from "react-aria-components";
import { GLOBAL_DEFAULT_BLUEPRINT_ID } from "@roubo/shared";
import { useGlobalBlueprint, useProjectBlueprint } from "../../hooks/useBlueprints";
import BlueprintEditorForm from "./BlueprintEditorForm";

interface Props {
  mode: "create" | "edit";
  scope: "global" | "project";
}

export default function BlueprintEditor({ mode, scope }: Props) {
  const { blueprintId, projectId } = useParams<{
    blueprintId: string;
    projectId: string;
  }>();
  const navigate = useNavigate();

  const backHref =
    scope === "project" && projectId ? `/projects/${projectId}/settings` : "/settings";
  const backLabel = scope === "project" ? "Back to project settings" : "Back to Settings";

  // Guard reserved ID
  if (mode === "edit" && blueprintId === GLOBAL_DEFAULT_BLUEPRINT_ID) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <p className="text-sm text-stone-600 dark:text-stone-400 max-w-sm">
          The built-in default blueprint cannot be edited. Create a custom blueprint to override it.
        </p>
        <Button
          onPress={() => navigate(backHref)}
          className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none"
        >
          {backLabel}
        </Button>
      </div>
    );
  }

  if (mode === "edit") {
    if (!blueprintId) return null;
    return (
      <EditLoader
        blueprintId={blueprintId}
        scope={scope}
        projectId={projectId}
        backHref={backHref}
        backLabel={backLabel}
      />
    );
  }

  return <BlueprintEditorForm mode="create" scope={scope} projectId={projectId} />;
}

interface EditLoaderProps {
  blueprintId: string;
  scope: "global" | "project";
  projectId: string | undefined;
  backHref: string;
  backLabel: string;
}

function EditLoader({ blueprintId, scope, projectId, backHref, backLabel }: EditLoaderProps) {
  const navigate = useNavigate();
  const isProject = scope === "project";
  const globalQuery = useGlobalBlueprint(isProject ? undefined : blueprintId);
  const projectQuery = useProjectBlueprint(
    isProject ? projectId : undefined,
    isProject ? blueprintId : undefined,
  );
  // Both queries are mounted to keep hook order stable, but the inactive one is
  // disabled. In React Query v5 a disabled query stays in `pending` indefinitely,
  // so we must read state from whichever query is active for this scope.
  const { data, isPending, error } = isProject ? projectQuery : globalQuery;

  if (isPending) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-stone-400 dark:text-stone-600">Loading blueprint…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <p className="text-sm text-stone-600 dark:text-stone-400">Blueprint not found.</p>
        <Button
          onPress={() => navigate(backHref)}
          className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none"
        >
          {backLabel}
        </Button>
      </div>
    );
  }

  return <BlueprintEditorForm initial={data} mode="edit" scope={scope} projectId={projectId} />;
}
