import { Activity } from "lucide-react";
import { useProjects } from "../../hooks/useProjects";
import Tile from "./Tile";

interface Props {
  projectId: string;
}

export default function PortAssignmentTile({ projectId }: Props) {
  const { data: projects, isLoading } = useProjects();
  const project = projects?.find((p) => p.id === projectId);

  const portEntries =
    project?.config && project.configValid ? Object.entries(project.config.ports) : null;

  const notConfigured = !isLoading && (!portEntries || portEntries.length === 0);

  return (
    <Tile icon={<Activity aria-hidden="true" size={14} />} title="Port assignment">
      {isLoading && (
        <div className="space-y-2">
          <div className="h-5 bg-bg-pressed rounded w-32" />
          <div className="h-4 bg-bg-pressed rounded w-48" />
        </div>
      )}
      {notConfigured && <p className="text-12 text-text-secondary">Not configured</p>}
      {!isLoading && portEntries && (
        <div className="space-y-1.5">
          {portEntries.map(([name, config]) => (
            <div key={name} className="flex items-baseline gap-2">
              <span className="font-mono text-11 text-text-secondary min-w-0">{name}</span>
              <span className="text-text-secondary">·</span>
              <span className="font-mono text-13 font-medium text-text-primary">{config.base}</span>
            </div>
          ))}
          <p className="text-11 text-text-secondary pt-1">Each port increments by 1 per bench</p>
        </div>
      )}
    </Tile>
  );
}
