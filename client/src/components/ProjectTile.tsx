import { useNavigate } from "react-router";
import { Button } from "react-aria-components";
import type { RegisteredProject, Bench } from "@roubo/shared";

export default function ProjectTile({
  project,
  benches,
}: {
  project: RegisteredProject;
  benches: Bench[];
}) {
  const navigate = useNavigate();
  const maxBenches = project.config?.benches?.max ?? 0;
  const usedBenches = benches.length;
  const fillPct = maxBenches > 0 ? Math.min(100, Math.round((usedBenches / maxBenches) * 100)) : 0;
  const layoutType = project.config?.layout?.type;
  const displayName = project.config?.project?.displayName ?? project.id;

  return (
    <Button
      onPress={() => navigate(`/projects/${project.id}`)}
      className="text-left rounded-control border border-border bg-bg-surface p-5 hover:border-border-strong hover:bg-bg-hover transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <div className="text-14 font-medium text-text-primary truncate">{displayName}</div>
          <div className="text-11 font-mono text-text-secondary mt-0.5 truncate">
            {project.id} · {project.repoPath}
          </div>
        </div>
        <span
          className={[
            "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-11 font-medium shrink-0 ml-2",
            project.configValid
              ? "bg-success-surface border border-success-border text-success-text"
              : "bg-danger-surface border border-danger-border text-danger-text",
          ].join(" ")}
        >
          <span
            className={`w-1 h-1 rounded-full ${project.configValid ? "bg-status-active" : "bg-status-error"}`}
          />
          {project.configValid ? "Valid" : "Error"}
        </span>
      </div>

      <div className="flex items-center gap-3 text-11 text-text-secondary">
        <span>
          {usedBenches} / {maxBenches} benches
        </span>
        {layoutType && (
          <>
            <span className="text-text-secondary">·</span>
            <span>{layoutType}</span>
          </>
        )}
      </div>

      {maxBenches > 0 && (
        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1 h-1 rounded-full bg-bg-pressed overflow-hidden">
            <div
              className="h-full bg-text-secondary transition-colors duration-300"
              style={{ width: `${fillPct}%` }}
            />
          </div>
          <span className="text-11 font-mono text-text-secondary">{fillPct}%</span>
        </div>
      )}
    </Button>
  );
}
