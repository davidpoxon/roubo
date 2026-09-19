import { useMemo } from "react";
import { useLocation, useNavigate } from "react-router";
import { Layers, Settings, Plus, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useProjects } from "../hooks/useProjects";
import { useAllBenches } from "../hooks/useBenches";
import { useSidebarCollapsed } from "../hooks/useSidebarCollapsed";
import NotificationIndicator from "./NotificationIndicator";
import NavItem from "./ui/NavItem";
import IconButton from "./ui/IconButton";
import { STATUS_DOT_CLASSES, type StatusTone } from "./ui/styles";
import { useRegisterProjectModal } from "../hooks/useRegisterProjectModal";
import { collectActionNeeded } from "../lib/notifications";
import type { Bench, BenchStatus, RegisteredProject } from "@roubo/shared";

// Bench statuses onto the DESIGN.md status tokens. Clearing is work in
// progress, so it shares `status-preparing`.
const BENCH_STATUS_TONE: Record<BenchStatus, StatusTone> = {
  active: "active",
  preparing: "preparing",
  clearing: "preparing",
  error: "error",
  idle: "idle",
};

export default function ProjectSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const { data: allBenches } = useAllBenches();
  const { open: openRegisterModal } = useRegisterProjectModal();
  // Projects-sidebar collapse (#524): reclaim its fixed 240px so the main
  // content (e.g. the TestBench case-detail pane) can grow wide enough for its
  // expanded layouts. Persisted app-wide.
  const { collapsed, setCollapsed } = useSidebarCollapsed();

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

  if (collapsed) {
    // Icon-only rail: All Projects, an expand control, and Settings. The project
    // list is hidden to free horizontal space (#524).
    return (
      <aside className="w-12 h-full flex flex-col items-center border-r border-border bg-bg-base shrink-0">
        <div className="flex-1 px-1.5 pt-3 flex flex-col items-center gap-1">
          <NavItem
            onPress={() => navigate("/")}
            aria-label="All Projects"
            isSelected={isActive("/")}
            className="justify-center w-9 h-9 px-0 py-0"
          >
            <Layers size={16} />
          </NavItem>
          <IconButton
            onPress={() => setCollapsed(false)}
            label="Expand sidebar"
            aria-expanded={false}
            placement="right"
            className="w-9 h-9"
          >
            <PanelLeftOpen size={16} />
          </IconButton>
        </div>
        <div className="px-1.5 py-3 border-t border-border w-full flex justify-center">
          <NavItem
            onPress={() => navigate("/settings")}
            aria-label="Settings"
            isSelected={isActive("/settings")}
            className="justify-center w-9 h-9 px-0 py-0"
          >
            <Settings size={16} />
          </NavItem>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-60 h-full flex flex-col border-r border-border bg-bg-base shrink-0">
      <nav className="flex-1 px-3 pt-3 overflow-auto">
        <NavItem
          onPress={() => navigate("/")}
          isSelected={isActive("/")}
          className="w-full justify-between"
        >
          <span className="flex items-center gap-2">
            <Layers size={14} />
            All Projects
          </span>
          <NotificationIndicator notifications={collectActionNeeded(allBenches ?? [])} />
        </NavItem>

        {(projects?.length ?? 0) > 0 && (
          <div className="mt-6">
            <div className="flex items-center justify-between px-3 pb-2">
              <p className="text-11 font-semibold uppercase tracking-label text-text-secondary">
                Projects
              </p>
              <IconButton onPress={openRegisterModal} label="Register project" className="p-0.5">
                <Plus size={14} />
              </IconButton>
            </div>
            <div className="space-y-0.5">
              {projects?.map((project) => (
                <ProjectSidebarRow
                  key={project.id}
                  project={project}
                  projectBenches={benchesByProject.get(project.id) ?? []}
                  isProjectActive={isProjectActive(project.id)}
                  isBenchActive={isBenchActive}
                  navigate={navigate}
                />
              ))}
            </div>
            <NavItem onPress={openRegisterModal} className="w-full gap-2 mt-0.5 text-12">
              <Plus size={12} />
              Register project
            </NavItem>
          </div>
        )}
      </nav>

      <div className="px-3 py-3 border-t border-border flex items-center gap-1">
        <NavItem
          onPress={() => navigate("/settings")}
          isSelected={isActive("/settings")}
          className="w-full gap-2"
        >
          <Settings size={14} />
          Settings
        </NavItem>
        <IconButton
          onPress={() => setCollapsed(true)}
          label="Collapse sidebar"
          aria-expanded={true}
          className="shrink-0 p-2"
        >
          <PanelLeftClose size={14} />
        </IconButton>
      </div>
    </aside>
  );
}

function ProjectSidebarRow({
  project,
  projectBenches,
  isProjectActive,
  isBenchActive,
  navigate,
}: {
  project: RegisteredProject;
  projectBenches: Bench[];
  isProjectActive: boolean;
  isBenchActive: (projectId: string, benchId: number) => boolean;
  navigate: (path: string) => void;
}) {
  return (
    <div data-project-id={project.id}>
      <NavItem
        onPress={() => navigate(`/projects/${project.id}`)}
        isSelected={isProjectActive}
        className="w-full justify-between gap-2"
      >
        <span className="truncate">{project.config?.project?.displayName ?? project.id}</span>
        <div className="flex items-center gap-1.5 shrink-0">
          <NotificationIndicator notifications={collectActionNeeded(projectBenches)} />
          {projectBenches.length > 0 && (
            <span className="text-11 font-medium text-text-secondary tabular-nums min-w-[18px] text-center">
              {projectBenches.length}
            </span>
          )}
        </div>
      </NavItem>
      {projectBenches.map((bench) => {
        const active = isBenchActive(project.id, bench.id);
        return (
          <NavItem
            key={bench.id}
            onPress={() => navigate(`/projects/${project.id}/benches/${bench.id}`)}
            isSelected={active}
            className="w-full gap-2 pl-7 text-12"
          >
            <span
              role="img"
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT_CLASSES[BENCH_STATUS_TONE[bench.status]]}`}
              aria-label={bench.status}
            />
            <span className="font-mono text-11 truncate">{bench.branch}</span>
            {!active && <NotificationIndicator notifications={bench.notifications} />}
          </NavItem>
        );
      })}
    </div>
  );
}
