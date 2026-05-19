import { useNavigate } from "react-router-dom";
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
      className="text-left rounded-xl border border-stone-200 dark:border-stone-800/80 bg-white dark:bg-stone-900/30 p-5 hover:border-stone-300 dark:hover:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-900/50 transition-all duration-150 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-stone-900 dark:text-stone-100 truncate">
            {displayName}
          </div>
          <div className="text-[11px] font-mono text-stone-400 dark:text-stone-500 mt-0.5 truncate">
            {project.id} · {project.repoPath}
          </div>
        </div>
        <span
          className={[
            "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium shrink-0 ml-2",
            project.configValid
              ? "bg-green-100 dark:bg-green-950/40 border border-green-300 dark:border-green-800/50 text-green-700 dark:text-green-400"
              : "bg-red-100 dark:bg-red-950/40 border border-red-300 dark:border-red-800/50 text-red-700 dark:text-red-400",
          ].join(" ")}
        >
          <span
            className={`w-1 h-1 rounded-full ${project.configValid ? "bg-green-500" : "bg-red-500"}`}
          />
          {project.configValid ? "Valid" : "Error"}
        </span>
      </div>

      <div className="flex items-center gap-3 text-[11px] text-stone-400 dark:text-stone-500">
        <span>
          {usedBenches} / {maxBenches} benches
        </span>
        {layoutType && (
          <>
            <span className="text-stone-300 dark:text-stone-700">·</span>
            <span>{layoutType}</span>
          </>
        )}
      </div>

      {maxBenches > 0 && (
        <div className="mt-3 flex items-center gap-3">
          <div className="flex-1 h-1 rounded-full bg-stone-200 dark:bg-stone-800 overflow-hidden">
            <div
              className="h-full bg-green-500/70 transition-all duration-300"
              style={{ width: `${fillPct}%` }}
            />
          </div>
          <span className="text-[10px] font-mono text-stone-400 dark:text-stone-500">
            {fillPct}%
          </span>
        </div>
      )}
    </Button>
  );
}
