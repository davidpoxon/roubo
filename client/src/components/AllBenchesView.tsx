import { useMemo } from "react";
import { Link } from "react-router";
import type { Bench } from "@roubo/shared";
import { useAllBenches } from "../hooks/useBenches";
import { useProjects } from "../hooks/useProjects";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import BenchCard from "./BenchCard";
import GlobalBenchMeter from "./GlobalBenchMeter";
import Spinner from "./Spinner";

interface BenchGroup {
  projectId: string;
  name: string;
  benches: Bench[];
  /** The project is not in the registered list, so there is no page to link to. */
  orphan: boolean;
}

/**
 * The All Benches view (`/` route): every bench across every registered
 * project, one section per project in sidebar order. Projects with no benches
 * are left out. A bench whose project is not in the project list still shows,
 * under its raw project id, so no bench is hidden. A failed load shows an
 * error, not an empty list.
 */
export default function AllBenchesView() {
  const { data: benches, isLoading: benchesLoading, isError: benchesError } = useAllBenches();
  const { data: projects, isLoading: projectsLoading, isError: projectsError } = useProjects();
  const isLoading = benchesLoading || projectsLoading;
  // A failed refetch keeps the last data, so only a load with nothing to show
  // is an error. Without projects, every bench would show as unregistered.
  const loadFailed = (benchesError && !benches) || (projectsError && !projects);
  const ready = !isLoading && !loadFailed;

  const groups = useMemo<BenchGroup[]>(() => {
    const byProject = new Map<string, Bench[]>();
    for (const bench of benches ?? []) {
      const existing = byProject.get(bench.projectId);
      if (existing) existing.push(bench);
      else byProject.set(bench.projectId, [bench]);
    }
    const result: BenchGroup[] = [];
    for (const project of projects ?? []) {
      const projectBenches = byProject.get(project.id);
      if (!projectBenches) continue;
      result.push({
        projectId: project.id,
        name: project.config?.project?.displayName ?? project.id,
        benches: projectBenches,
        orphan: false,
      });
      byProject.delete(project.id);
    }
    for (const [projectId, orphanBenches] of byProject) {
      result.push({ projectId, name: projectId, benches: orphanBenches, orphan: true });
    }
    return result;
  }, [benches, projects]);

  return (
    <div className="p-8 max-w-[1200px]">
      <div className="flex items-start justify-between mb-8">
        <div>
          <h2 className="text-20 font-semibold text-text-primary">All Benches</h2>
          <p className="text-12 text-text-secondary mt-1">Every bench across your projects.</p>
        </div>
        <GlobalBenchMeter />
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-13 text-text-secondary py-12">
          <Spinner />
          Loading...
        </div>
      )}

      {!isLoading && loadFailed && (
        <p role="alert" className="text-13 text-danger-text py-12">
          Could not load benches. Check that the Roubo server is running, then reload.
        </p>
      )}

      {ready && groups.length === 0 && (
        <p className="text-13 text-text-secondary py-12">
          No benches yet. Open a project from{" "}
          <Link
            to="/projects"
            className="text-text-body underline hover:text-text-primary transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Projects
          </Link>{" "}
          to set up a bench.
        </p>
      )}

      {ready && groups.length > 0 && (
        <div className="space-y-8">
          {groups.map((group) => (
            <ProjectBenchSection key={group.projectId} group={group} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectBenchSection({ group }: { group: BenchGroup }) {
  // BenchCard flags an issue from a previous integration against the
  // project's active one, so resolve it per project. An unregistered project
  // has no integration to ask the server for.
  const { data: integration } = useProjectIntegration(group.orphan ? undefined : group.projectId);
  const activeIntegrationId = integration?.plugin?.id ?? null;

  return (
    <section aria-labelledby={`all-benches-${group.projectId}`}>
      <h3 id={`all-benches-${group.projectId}`} className="flex items-baseline gap-2 mb-3">
        {group.orphan ? (
          <span className="text-14 font-medium text-text-primary">{group.name}</span>
        ) : (
          <Link
            to={`/projects/${group.projectId}`}
            className="text-14 font-medium text-text-primary hover:underline outline-none focus-visible:ring-2 focus-visible:ring-focus-ring rounded-control"
          >
            {group.name}
          </Link>
        )}
        <span className="text-11 font-medium text-text-secondary tabular-nums">
          {group.benches.length}
        </span>
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {group.benches.map((bench) => (
          <BenchCard
            key={`${bench.projectId}-${bench.id}`}
            bench={bench}
            activeIntegrationId={activeIntegrationId}
          />
        ))}
      </div>
    </section>
  );
}
