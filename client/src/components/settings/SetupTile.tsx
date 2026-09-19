import { useNavigate } from "react-router";
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
      <span className="text-text-secondary">{label}: </span>
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
    <pre className="text-11 font-mono leading-relaxed bg-bg-base rounded-md p-3 overflow-hidden">
      <YamlPreviewLine label="name" value={config.project.name} />
      <span className="text-text-secondary">{"components:\n"}</span>
      {shownKeys.map((k) => (
        <span key={k}>{`  ${k}\n`}</span>
      ))}
      {hasMore && <span>{"  …\n"}</span>}
      {lowestBase !== null && (
        <>
          <span className="text-text-secondary">{"ports:\n"}</span>
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
      className="text-11 px-2.5 py-1 rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus-ring cursor-pointer"
    >
      Edit setup →
    </Button>
  );

  return (
    <Tile
      icon={<FileCode aria-hidden="true" size={14} />}
      title="Project setup"
      secondary={<code className="text-11">.roubo/roubo.yaml</code>}
      headerAction={editButton}
      ariaLabel="Project setup"
    >
      {isLoading && (
        <div data-testid="setup-tile-loading" className="space-y-2">
          <div className="h-3 bg-bg-pressed rounded w-3/4" />
          <div className="h-3 bg-bg-pressed rounded w-1/2" />
          <div className="h-3 bg-bg-pressed rounded w-2/3" />
        </div>
      )}
      {!isLoading && !project && <p className="text-12 text-text-secondary">Project not found</p>}
      {!isLoading && project && !validConfig && (
        <div role="alert" className="flex items-start gap-2">
          <AlertCircle aria-hidden="true" size={14} className="text-danger-text shrink-0 mt-0.5" />
          <div>
            <p className="text-12 font-medium text-danger-text">Config missing or invalid</p>
            {project.configError && (
              <p className="text-11 font-mono text-text-secondary mt-1">{project.configError}</p>
            )}
          </div>
        </div>
      )}
      {!isLoading && validConfig && <YamlPreview config={validConfig} />}
    </Tile>
  );
}
