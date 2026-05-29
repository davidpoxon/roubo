import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "react-aria-components";
import { Layers, Settings, Plus } from "lucide-react";
import { useProjects } from "../hooks/useProjects";
import { useAllBenches } from "../hooks/useBenches";
import NotificationIndicator from "./NotificationIndicator";
import { useRegisterProjectModal } from "../hooks/useRegisterProjectModal";
import { collectActionNeeded } from "../lib/notifications";
import type { Bench, BenchStatus, RegisteredProject } from "@roubo/shared";

const statusDotColor: Record<BenchStatus, string> = {
  active: "bg-green-500",
  preparing: "bg-amber-500",
  clearing: "bg-amber-500",
  error: "bg-red-500",
  idle: "bg-stone-300 dark:bg-stone-700",
};

export default function ProjectSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const { data: allBenches } = useAllBenches();
  const { open: openRegisterModal } = useRegisterProjectModal();

  const benchesByProject = useMemo(() => {
    const map = new Map<string, NonNullable<typeof allBenches>>();
    for (const bench of allBenches ?? []) {
      const existing = map.get(bench.projectId);
      if (existing) existing.push(bench);
      else map.set(bench.projectId, [bench]);
    }
    return map;
  }, [allBenches]);

  const isActive = (path: string) => location.pathname === path;
  const isProjectActive = (projectId: string) => location.pathname === `/projects/${projectId}`;
  const isBenchActive = (projectId: string, benchId: number) =>
    location.pathname === `/projects/${projectId}/benches/${benchId}`;

  const navColorClass = (active: boolean) =>
    active
      ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
      : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-800/40";

  const navItemClass = (active: boolean, layout = "gap-2.5") =>
    `w-full flex items-center ${layout} px-3 py-2 rounded-lg text-[13px] transition-colors duration-100 outline-none ${navColorClass(active)}`;

  const benchItemClass = (active: boolean) =>
    `w-full flex items-center gap-2 pl-7 pr-3 py-1.5 rounded-lg text-[12px] transition-colors duration-100 outline-none ${navColorClass(active)}`;

  return (
    <aside className="w-60 h-full flex flex-col border-r border-stone-200 dark:border-stone-800/40 bg-stone-50 dark:bg-stone-950/60 shrink-0">
      <nav className="flex-1 px-3 pt-3 overflow-auto">
        <Button
          onPress={() => navigate("/")}
          className={navItemClass(isActive("/"), "justify-between")}
        >
          <span className="flex items-center gap-2.5">
            <Layers size={14} />
            All Projects
          </span>
          <NotificationIndicator notifications={collectActionNeeded(allBenches ?? [])} />
        </Button>

        {(projects?.length ?? 0) > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-between px-3 pb-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-400 dark:text-stone-600">
                Projects
              </p>
              <Button
                onPress={openRegisterModal}
                aria-label="Register project"
                className="p-0.5 rounded text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-800 transition-colors outline-none focus-visible:ring-1 focus-visible:ring-amber-500"
              >
                <Plus size={13} />
              </Button>
            </div>
            <div className="space-y-0.5">
              {projects?.map((project) => (
                <ProjectSidebarRow
                  key={project.id}
                  project={project}
                  projectBenches={benchesByProject.get(project.id) ?? []}
                  isProjectActive={isProjectActive(project.id)}
                  navItemClass={navItemClass}
                  benchItemClass={benchItemClass}
                  isBenchActive={isBenchActive}
                  navigate={navigate}
                />
              ))}
            </div>
            <Button
              onPress={openRegisterModal}
              className="w-full flex items-center gap-2 px-3 py-1.5 mt-0.5 rounded-lg text-[12px] text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-800/40 transition-colors duration-100 outline-none"
            >
              <Plus size={12} />
              Register project
            </Button>
          </div>
        )}
      </nav>

      <div className="px-3 py-3 border-t border-stone-200 dark:border-stone-800/40">
        <Button
          onPress={() => navigate("/settings")}
          className={navItemClass(isActive("/settings"))}
        >
          <Settings size={14} />
          Settings
        </Button>
      </div>
    </aside>
  );
}

function ProjectSidebarRow({
  project,
  projectBenches,
  isProjectActive,
  navItemClass,
  benchItemClass,
  isBenchActive,
  navigate,
}: {
  project: RegisteredProject;
  projectBenches: Bench[];
  isProjectActive: boolean;
  navItemClass: (active: boolean, layout?: string) => string;
  benchItemClass: (active: boolean) => string;
  isBenchActive: (projectId: string, benchId: number) => boolean;
  navigate: (path: string) => void;
}) {
  return (
    <div data-project-id={project.id}>
      <Button
        onPress={() => navigate(`/projects/${project.id}`)}
        className={navItemClass(isProjectActive, "justify-between")}
      >
        <span className="truncate">{project.config?.project?.displayName ?? project.id}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <NotificationIndicator notifications={collectActionNeeded(projectBenches)} />
          {projectBenches.length > 0 && (
            <span className="text-[10px] font-medium text-stone-500 dark:text-stone-600 bg-stone-200 dark:bg-stone-800/80 rounded-full px-1.5 py-px min-w-[18px] text-center">
              {projectBenches.length}
            </span>
          )}
        </div>
      </Button>
      {projectBenches.map((bench) => {
        const active = isBenchActive(project.id, bench.id);
        return (
          <Button
            key={bench.id}
            onPress={() => navigate(`/projects/${project.id}/benches/${bench.id}`)}
            className={benchItemClass(active)}
          >
            <span
              role="img"
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDotColor[bench.status]}`}
              aria-label={bench.status}
            />
            <span className="font-mono text-[11px] truncate">{bench.branch}</span>
            {!active && <NotificationIndicator notifications={bench.notifications} />}
          </Button>
        );
      })}
    </div>
  );
}
