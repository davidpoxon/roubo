import { useParams, useNavigate } from "react-router-dom";
import { Button } from "react-aria-components";
import { GLOBAL_DEFAULT_JIG_ID } from "@roubo/shared";
import { useGlobalJig, useProjectJig } from "../../hooks/useJigs";
import JigEditorForm from "./JigEditorForm";

interface Props {
  mode: "create" | "edit";
  scope: "global" | "project";
}

export default function JigEditor({ mode, scope }: Props) {
  const { jigId, projectId } = useParams<{
    jigId: string;
    projectId: string;
  }>();
  const navigate = useNavigate();

  const backHref =
    scope === "project" && projectId ? `/projects/${projectId}/settings` : "/settings";
  const backLabel = scope === "project" ? "Back to project settings" : "Back to Settings";

  // Guard reserved ID
  if (mode === "edit" && jigId === GLOBAL_DEFAULT_JIG_ID) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <p className="text-sm text-stone-600 dark:text-stone-400 max-w-sm">
          The built-in default jig cannot be edited. Create a custom jig to override it.
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
    if (!jigId) return null;
    return (
      <EditLoader
        jigId={jigId}
        scope={scope}
        projectId={projectId}
        backHref={backHref}
        backLabel={backLabel}
      />
    );
  }

  return <JigEditorForm mode="create" scope={scope} projectId={projectId} />;
}

interface EditLoaderProps {
  jigId: string;
  scope: "global" | "project";
  projectId: string | undefined;
  backHref: string;
  backLabel: string;
}

function EditLoader({ jigId, scope, projectId, backHref, backLabel }: EditLoaderProps) {
  const navigate = useNavigate();
  const isProject = scope === "project";
  const globalQuery = useGlobalJig(isProject ? undefined : jigId);
  const projectQuery = useProjectJig(
    isProject ? projectId : undefined,
    isProject ? jigId : undefined,
  );
  // Both queries are mounted to keep hook order stable, but the inactive one is
  // disabled. In React Query v5 a disabled query stays in `pending` indefinitely,
  // so we must read state from whichever query is active for this scope.
  const { data, isPending, error } = isProject ? projectQuery : globalQuery;

  if (isPending) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-sm text-stone-400 dark:text-stone-600">Loading jig…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <p className="text-sm text-stone-600 dark:text-stone-400">Jig not found.</p>
        <Button
          onPress={() => navigate(backHref)}
          className="px-4 py-1.5 text-sm font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none"
        >
          {backLabel}
        </Button>
      </div>
    );
  }

  return <JigEditorForm initial={data} mode="edit" scope={scope} projectId={projectId} />;
}
