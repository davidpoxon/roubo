import { useState, useMemo, useCallback } from "react";
import { useParams, Outlet, NavLink, useMatch, useLocation } from "react-router-dom";
import { Button } from "react-aria-components";
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { Plus, PanelLeft } from "lucide-react";
import { useProjects } from "../hooks/useProjects";
import { useProjectBenches, useCreateBench } from "../hooks/useBenches";
import { useToast } from "../hooks/useToast";
import type {
  Bench,
  RouboConfig,
  GitHubProjectItem,
  BranchConflictInfo,
  CreateBenchWithIssueResponse,
} from "@roubo/shared";
import CreateBenchModal from "./CreateBenchModal";
import { createEmptyFilters } from "../lib/cut-list-filters";
import type { FilterState } from "../lib/cut-list-filters";
import { createEmptyGrouping } from "../lib/cut-list-groups";
import type { GroupingState } from "../lib/cut-list-groups";
import IssuePickerModal from "./IssuePickerModal";
import BranchConflictDialog from "./BranchConflictDialog";
import Spinner from "./Spinner";
import GitHubErrorState from "./GitHubErrorState";
import { useGitHubAuth } from "../hooks/useGitHubAuth";
import { buildNotConnectedError } from "../lib/api";
import ProjectTile from "./ProjectTile";
import RegisterProjectTile from "./RegisterProjectTile";
import { useRegisterProjectModal } from "./RegisterProjectModalProvider";

export type ProjectOutletContext = {
  benchPositions: Array<{ position: number; bench?: Bench }> | null;
  pendingAssignments: Map<number, { issueNumber: number; issueTitle: string }>;
  isLoading: boolean;
  openCreateBench: () => void;
  pickIssueForBench: (position: number) => void;
  hasGitHub: boolean;
  benches: Bench[];
  projectConfig: RouboConfig;
  pendingIssueNumbers: Set<number>;
  initialFilters: FilterState;
  onFiltersChange: (projectId: string, filters: FilterState) => void;
  initialGrouping: GroupingState;
  onGroupingChange: (projectId: string, grouping: GroupingState) => void;
  issueQueueCollapsed: boolean;
  onToggleIssueQueue: () => void;
  projectId: string;
};

const tabClassName = ({ isActive }: { isActive: boolean }) =>
  `px-3 py-2 text-xs font-medium transition-colors outline-none cursor-pointer border-b-2 -mb-px ${
    isActive
      ? "text-stone-800 dark:text-stone-200 border-amber-500"
      : "text-stone-500 dark:text-stone-600 border-transparent hover:text-stone-700 dark:hover:text-stone-400"
  }`;

export default function BenchDashboard() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const isOnSettings = !!useMatch("/projects/:projectId/settings/*"); // keep in sync with the 'settings/*' child route in App.tsx
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const { data: benches, isLoading: benchesLoading } = useProjectBenches(projectId);
  const { status: githubStatus } = useGitHubAuth();
  const createBench = useCreateBench();
  const { addToast } = useToast();

  const [showCreate, setShowCreate] = useState(false);
  const [showIssuePicker, setShowIssuePicker] = useState(false);
  const { open: openRegisterModal } = useRegisterProjectModal();
  const [branchConflict, setBranchConflict] = useState<
    (BranchConflictInfo & { issueNumber: number }) | null
  >(null);
  const [draggingItem, setDraggingItem] = useState<GitHubProjectItem | null>(null);
  const [issueQueueCollapsed, setIssueQueueCollapsed] = useState(false);
  const [pendingIssueNumbers, setPendingIssueNumbers] = useState<Set<number>>(new Set());
  const [pendingAssignments, setPendingAssignments] = useState<
    Map<number, { issueNumber: number; issueTitle: string }>
  >(new Map());
  const [issuePickerPosition, setIssuePickerPosition] = useState<number | null>(null);
  const [filterCache, setFilterCache] = useState<Map<string, FilterState>>(new Map());
  const [groupingCache, setGroupingCache] = useState<Map<string, GroupingState>>(new Map());

  const initialFilters = projectId
    ? (filterCache.get(projectId) ?? createEmptyFilters())
    : createEmptyFilters();
  const handleFiltersChange = useCallback((pid: string, filters: FilterState) => {
    setFilterCache((prev) => new Map(prev).set(pid, filters));
  }, []);

  const initialGrouping = projectId
    ? (groupingCache.get(projectId) ?? createEmptyGrouping())
    : createEmptyGrouping();
  const handleGroupingChange = useCallback((pid: string, grouping: GroupingState) => {
    setGroupingCache((prev) => new Map(prev).set(pid, grouping));
  }, []);

  const openCreateBench = useCallback(() => setShowCreate(true), []);
  const onToggleIssueQueue = useCallback(() => setIssueQueueCollapsed((prev) => !prev), []);

  const addPending = useCallback((issueNumber: number) => {
    setPendingIssueNumbers((prev) => new Set(prev).add(issueNumber));
  }, []);

  const removePending = useCallback((issueNumber: number) => {
    setPendingIssueNumbers((prev) => {
      const next = new Set(prev);
      next.delete(issueNumber);
      return next;
    });
  }, []);

  const currentProject = projects?.find((a) => a.id === projectId);

  const hasGitHub =
    !!currentProject?.config?.project?.github?.project || !!currentProject?.config?.project?.repo;
  const maxBenches = currentProject?.config?.benches?.max ?? 0;

  const benchPositions = useMemo(() => {
    if (!projectId || !maxBenches) return null;
    const positions: Array<{ position: number; bench?: Bench }> = [];
    const benchMap = new Map<number, Bench>();
    for (const s of benches ?? []) {
      benchMap.set(s.id, s);
    }
    for (let i = 1; i <= maxBenches; i++) {
      positions.push({ position: i, bench: benchMap.get(i) });
    }
    return positions;
  }, [projectId, maxBenches, benches]);

  const grouped = useMemo(() => {
    if (!benches) return new Map<string, Bench[]>();
    if (projectId) return new Map([[projectId, benches]]);
    const map = new Map<string, Bench[]>();
    for (const bench of benches) {
      const arr = map.get(bench.projectId) ?? [];
      arr.push(bench);
      map.set(bench.projectId, arr);
    }
    return map;
  }, [benches, projectId]);

  const isLoading = projectsLoading || benchesLoading;

  const clearPendingAssignment = useCallback((issueNumber: number) => {
    setPendingAssignments((prev) => {
      const next = new Map(prev);
      for (const [pos, assignment] of next) {
        if (assignment.issueNumber === issueNumber) {
          next.delete(pos);
          break;
        }
      }
      return next;
    });
  }, []);

  const handleCreateBenchWithIssue = useCallback(
    (issueNumber: number, conflictResolution?: "resume" | "new") => {
      if (!projectId) return;
      createBench.mutate(
        {
          projectId,
          issueNumber,
          branchConflictResolution: conflictResolution,
        },
        {
          onSuccess: (result) => {
            removePending(issueNumber);
            clearPendingAssignment(issueNumber);
            const response = result as CreateBenchWithIssueResponse;
            if (response.status === "conflict") {
              setBranchConflict({ ...response.branchConflict, issueNumber });
            }
          },
          onError: () => {
            removePending(issueNumber);
            clearPendingAssignment(issueNumber);
          },
        },
      );
    },
    [projectId, createBench, removePending, clearPendingAssignment],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const item = event.active.data.current?.item as GitHubProjectItem | undefined;
    setDraggingItem(item ?? null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingItem(null);
      const { active, over } = event;
      if (!over || !projectId) return;

      const item = active.data.current?.item as GitHubProjectItem | undefined;
      const position = over.data.current?.position as number | undefined;
      if (!item || position === undefined) return;

      addPending(item.issue.number);
      setPendingAssignments((prev) => {
        const next = new Map(prev);
        next.set(position, {
          issueNumber: item.issue.number,
          issueTitle: item.issue.title,
        });
        return next;
      });

      let cancelled = false;
      addToast(`Setting up bench for #${item.issue.number} — ${item.issue.title}`, {
        duration: 3000,
        action: {
          label: "Cancel",
          onPress: () => {
            cancelled = true;
            removePending(item.issue.number);
            setPendingAssignments((prev) => {
              const next = new Map(prev);
              next.delete(position);
              return next;
            });
          },
        },
        onExpire: () => {
          if (!cancelled) {
            handleCreateBenchWithIssue(item.issue.number);
          }
        },
      });
    },
    [projectId, addToast, handleCreateBenchWithIssue, addPending, removePending],
  );

  const handleEmptyBenchPickIssue = useCallback((position: number) => {
    setIssuePickerPosition(position);
    setShowIssuePicker(true);
  }, []);

  const outletContext = useMemo(
    () =>
      ({
        benchPositions,
        pendingAssignments,
        isLoading,
        openCreateBench,
        pickIssueForBench: handleEmptyBenchPickIssue,
        hasGitHub,
        benches: benches ?? [],
        projectConfig: currentProject?.config as RouboConfig,
        pendingIssueNumbers,
        initialFilters,
        onFiltersChange: handleFiltersChange,
        initialGrouping,
        onGroupingChange: handleGroupingChange,
        issueQueueCollapsed,
        onToggleIssueQueue,
        projectId: projectId ?? "",
      }) satisfies ProjectOutletContext,
    [
      benchPositions,
      pendingAssignments,
      isLoading,
      openCreateBench,
      handleEmptyBenchPickIssue,
      hasGitHub,
      benches,
      currentProject?.config,
      pendingIssueNumbers,
      initialFilters,
      handleFiltersChange,
      initialGrouping,
      handleGroupingChange,
      issueQueueCollapsed,
      onToggleIssueQueue,
      projectId,
    ],
  );

  const handleIssuePickerSelect = useCallback(
    (issueNumber: number, issueTitle: string) => {
      setShowIssuePicker(false);
      if (!projectId) return;
      addPending(issueNumber);
      const position = issuePickerPosition;
      if (position !== null) {
        setPendingAssignments((prev) => {
          const next = new Map(prev);
          next.set(position, { issueNumber, issueTitle });
          return next;
        });
      }
      let cancelled = false;
      addToast(`Setting up bench for #${issueNumber} — ${issueTitle}`, {
        duration: 3000,
        action: {
          label: "Cancel",
          onPress: () => {
            cancelled = true;
            removePending(issueNumber);
            if (position !== null) {
              setPendingAssignments((prev) => {
                const next = new Map(prev);
                next.delete(position);
                return next;
              });
            }
          },
        },
        onExpire: () => {
          if (!cancelled) {
            handleCreateBenchWithIssue(issueNumber);
          }
        },
      });
    },
    [
      projectId,
      issuePickerPosition,
      addToast,
      handleCreateBenchWithIssue,
      addPending,
      removePending,
    ],
  );

  // All-projects view (/ route) and fallback when project data is loading
  if (!projectId || !currentProject || !currentProject.config) {
    return (
      <div className="p-8 max-w-[1200px]">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
              All Projects
            </h2>
            <p className="text-[12px] text-stone-400 dark:text-stone-500 mt-1">
              Registered projects. Click one to view its benches and settings.
            </p>
          </div>
          <Button
            onPress={openRegisterModal}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none"
          >
            <Plus size={14} />
            Register project
          </Button>
        </div>

        {githubStatus !== undefined &&
          !githubStatus.connected &&
          projects?.some((p) => p.config?.project?.repo) && (
            <GitHubErrorState error={buildNotConnectedError()} variant="banner" className="mb-6" />
          )}

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-stone-400 dark:text-stone-600 py-12">
            <Spinner />
            Loading...
          </div>
        )}

        {!isLoading && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {projects?.map((project) => (
              <ProjectTile
                key={project.id}
                project={project}
                benches={grouped.get(project.id) ?? []}
              />
            ))}
            <RegisterProjectTile />
          </div>
        )}

        <CreateBenchModal
          isOpen={showCreate}
          onClose={() => setShowCreate(false)}
          projectId={projectId}
        />
      </div>
    );
  }

  // Single-project layout: tab strip + Outlet (Cut List lives inside BenchesTab)
  return (
    <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-full">
        <div className="border-b border-stone-200 dark:border-stone-800/60 px-8 pt-6">
          {githubStatus !== undefined &&
            !githubStatus.connected &&
            !!currentProject.config.project?.repo && (
              <GitHubErrorState
                error={buildNotConnectedError()}
                variant="banner"
                className="mb-4"
              />
            )}
          <nav aria-label="Project tabs" className="flex items-center gap-1">
            {hasGitHub && issueQueueCollapsed && !isOnSettings && (
              <Button
                onPress={onToggleIssueQueue}
                className="p-1.5 rounded-md text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none mr-1"
                aria-label="Show cut list"
              >
                <PanelLeft size={16} />
              </Button>
            )}
            <NavLink to="." end className={tabClassName}>
              Benches
            </NavLink>
            <NavLink to="settings" className={tabClassName}>
              Settings
            </NavLink>
          </nav>
        </div>

        <div key={location.pathname} className="flex-1 min-h-0 overflow-hidden animate-tab-fade-in">
          <Outlet context={outletContext} />
        </div>
      </div>

      <DragOverlay>
        {draggingItem && (
          <div className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 rounded-lg px-3 py-2 shadow-xl max-w-[280px] opacity-90">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-stone-400 dark:text-stone-500">
                #{draggingItem.issue.number}
              </span>
              <span className="text-xs font-medium text-stone-800 dark:text-stone-200 truncate">
                {draggingItem.issue.title}
              </span>
            </div>
          </div>
        )}
      </DragOverlay>

      <CreateBenchModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        projectId={projectId}
      />

      <IssuePickerModal
        isOpen={showIssuePicker}
        onClose={() => setShowIssuePicker(false)}
        onSelect={handleIssuePickerSelect}
        projectId={projectId}
        projectConfig={currentProject.config}
        benches={benches ?? []}
        pendingIssueNumbers={pendingIssueNumbers}
      />

      {branchConflict && (
        <BranchConflictDialog
          isOpen
          onClose={() => setBranchConflict(null)}
          conflict={branchConflict}
          onResume={() => {
            handleCreateBenchWithIssue(branchConflict.issueNumber, "resume");
            setBranchConflict(null);
          }}
          onCreateNew={() => {
            handleCreateBenchWithIssue(branchConflict.issueNumber, "new");
            setBranchConflict(null);
          }}
        />
      )}
    </DndContext>
  );
}
