import { useNavigate } from "react-router-dom";
import { Button } from "react-aria-components";
import { FileCode, AlertCircle } from "lucide-react";
import type { RouboConfig } from "@roubo/shared";
import { useProjects } from "../../hooks/useProjects";
import Tile from "./Tile";

interface Props {
  projectId: string;
}

function YamlPreviewLine({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-stone-400 dark:text-stone-500">{label}: </span>
      {value + "\n"}
    </span>
  );
}

function YamlPreview({ config }: { config: RouboConfig }) {
  const componentKeys = Object.keys(config.components);
  const shownKeys = componentKeys.slice(0, 3);
  const hasMore = componentKeys.length > 3;
  const portValues = Object.values(config.ports);
  const lowestBase = portValues.length > 0 ? Math.min(...portValues.map((p) => p.base)) : null;

  return (
    <pre className="text-[11px] font-mono leading-relaxed bg-stone-50 dark:bg-stone-950/50 rounded-md p-3 overflow-hidden">
      <YamlPreviewLine label="name" value={config.project.name} />
      <span className="text-stone-400 dark:text-stone-500">{"components:\n"}</span>
      {shownKeys.map((k) => (
        <span key={k}>{`  ${k}\n`}</span>
      ))}
      {hasMore && <span>{"  …\n"}</span>}
      {lowestBase !== null && (
        <>
          <span className="text-stone-400 dark:text-stone-500">{"ports:\n"}</span>
          <span>{`  base: ${lowestBase}`}</span>
        </>
      )}
    </pre>
  );
}

export default function SetupTile({ projectId }: Props) {
  const { data: projects, isLoading } = useProjects();
  const navigate = useNavigate();

  const project = projects?.find((p) => p.id === projectId);
  const validConfig = project?.configValid && project.config ? project.config : null;

  const editButton = (
    <Button
      aria-label="Edit project configuration"
      onPress={() => navigate(`/projects/${projectId}/settings/setup`)}
      className="text-[11px] px-2.5 py-1 rounded-md border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-300 dark:hover:border-stone-600 hover:text-stone-800 dark:hover:text-stone-100 outline-none focus-visible:ring-2 focus-visible:ring-amber-500 cursor-pointer"
    >
      Edit setup →
    </Button>
  );

  return (
    <Tile
      icon={<FileCode aria-hidden="true" size={14} />}
      title="Project setup"
      secondary={<code className="text-[10px]">.roubo/roubo.yaml</code>}
      headerAction={editButton}
      ariaLabel="Project setup"
    >
      {isLoading && (
        <div className="animate-pulse space-y-2">
          <div className="h-3 bg-stone-200 dark:bg-stone-700 rounded w-3/4" />
          <div className="h-3 bg-stone-200 dark:bg-stone-700 rounded w-1/2" />
          <div className="h-3 bg-stone-200 dark:bg-stone-700 rounded w-2/3" />
        </div>
      )}
      {!isLoading && !project && (
        <p className="text-[12px] text-stone-400 dark:text-stone-600">Project not found</p>
      )}
      {!isLoading && project && !validConfig && (
        <div role="alert" className="flex items-start gap-2">
          <AlertCircle
            aria-hidden="true"
            size={14}
            className="text-red-500 dark:text-red-400 shrink-0 mt-0.5"
          />
          <div>
            <p className="text-[12px] font-medium text-red-600 dark:text-red-400">
              Config missing or invalid
            </p>
            {project.configError && (
              <p className="text-[11px] font-mono text-stone-500 dark:text-stone-600 mt-1">
                {project.configError}
              </p>
            )}
          </div>
        </div>
      )}
      {!isLoading && validConfig && <YamlPreview config={validConfig} />}
    </Tile>
  );
}
