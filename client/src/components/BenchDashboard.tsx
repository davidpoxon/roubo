import { useState, useMemo, useCallback, useEffect } from "react";
import {
  useParams,
  Outlet,
  NavLink,
  Link,
  useMatch,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { Button } from "react-aria-components";
import { DndContext, DragOverlay, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { Plus, PanelLeft } from "lucide-react";
import { useProjects } from "../hooks/useProjects";
import { useProjectBenches, useCreateBench } from "../hooks/useBenches";
import { useToast } from "../hooks/useToast";
import type {
  Bench,
  RouboConfig,
  NormalizedIssue,
  BranchConflictInfo,
  CreateBenchWithIssueResponse,
} from "@roubo/shared";
import { issueNumberFromExternalId } from "../lib/issue-id";
import CreateBenchModal from "./CreateBenchModal";
import { createEmptyFilters } from "../lib/cut-list-filters";
import type { FilterState } from "../lib/cut-list-filters";
import { createEmptyGrouping } from "../lib/cut-list-groups";
import type { GroupingState } from "../lib/cut-list-groups";
import IssuePickerModal from "./IssuePickerModal";
import BranchConflictDialog from "./BranchConflictDialog";
import Spinner from "./Spinner";
import ProjectTile from "./ProjectTile";
import RegisterProjectTile from "./RegisterProjectTile";
import { useRegisterProjectModal } from "../hooks/useRegisterProjectModal";
import MissingPluginDialog from "./MissingPluginDialog";
import EnablePluginPromptModal from "./EnablePluginPromptModal";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
import { useSettings } from "../hooks/useSettings";
import { DEFAULT_TESTBENCH_SETTINGS } from "@roubo/shared";
import SpecPickerModal from "./testbench/SpecPickerModal";
import { setBenchActiveTab } from "../hooks/useBenchViewState";

export type ProjectOutletContext = {
  benchPositions: Array<{ position: number; bench?: Bench }> | null;
  pendingAssignments: Map<number, { externalId: string; issueTitle: string }>;
  isLoading: boolean;
  openCreateBench: () => void;
  pickIssueForBench: (position: number) => void;
  // TestBench create flow (#418). Only offered when the feature is enabled; the
  // handler opens the spec-picker modal for the empty slot.
  testBenchEnabled: boolean;
  onCreateTestBench: (position: number) => void;
  hasGitHub: boolean;
  benches: Bench[];
  projectConfig: RouboConfig;
  pendingIssueExternalIds: Set<string>;
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
  const navigate = useNavigate();
  const isOnSettings = !!useMatch("/projects/:projectId/settings/*"); // keep in sync with the 'settings/*' child route in App.tsx
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const { data: benches, isLoading: benchesLoading } = useProjectBenches(projectId);
  const { data: integration } = useProjectIntegration(projectId);
  const createBench = useCreateBench();
  const { addToast } = useToast();
  const { settings } = useSettings();
  const testBenchEnabled = settings?.testBench?.enabled ?? DEFAULT_TESTBENCH_SETTINGS.enabled;

  const [showCreate, setShowCreate] = useState(false);
  const [showIssuePicker, setShowIssuePicker] = useState(false);
  const [showSpecPicker, setShowSpecPicker] = useState(false);
  const { open: openRegisterModal } = useRegisterProjectModal();
  const [branchConflict, setBranchConflict] = useState<
    (BranchConflictInfo & { externalId: string; issueNumber: number | null }) | null
  >(null);
  const [draggingIssue, setDraggingIssue] = useState<NormalizedIssue | null>(null);
  const [issueQueueCollapsed, setIssueQueueCollapsed] = useState(false);
  // Set of in-flight NormalizedIssue.externalIds, used to dedupe the cut list and
  // picker. Keyed on externalId (not issueNumber) so security alerts (which have
  // no bare numeric form) are tracked uniformly with plain issues.
  const [pendingIssueExternalIds, setPendingIssueExternalIds] = useState<Set<string>>(new Set());
  const [pendingAssignments, setPendingAssignments] = useState<
    Map<number, { externalId: string; issueTitle: string }>
  >(new Map());
  const [issuePickerPosition, setIssuePickerPosition] = useState<number | null>(null);
  const [filterCache, setFilterCache] = useState<Map<string, FilterState>>(new Map());
  const [groupingCache, setGroupingCache] = useState<Map<string, GroupingState>>(new Map());
  // Session-scoped suppression of the "Plugin needed" prompt. Resets on page
  // reload; users always get a fresh chance to install on the next session.
  const [missingPluginSkipped, setMissingPluginSkipped] = useState<Set<string>>(new Set());
  // Session-scoped suppression of the "Enable plugin?" prompt. Same lifecycle
  // as missingPluginSkipped above; the two sets are kept separate because the
  // dialogs target different integration states.
  const [enablePluginSkipped, setEnablePluginSkipped] = useState<Set<string>>(new Set());

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

  const addPending = useCallback((externalId: string) => {
    setPendingIssueExternalIds((prev) => {
      const next = new Set(prev);
      next.add(externalId);
      return next;
    });
  }, []);

  const removePending = useCallback((externalId: string) => {
    setPendingIssueExternalIds((prev) => {
      const next = new Set(prev);
      next.delete(externalId);
      return next;
    });
  }, []);

  const currentProject = projects?.find((a) => a.id === projectId);
  const hasConfig = !!currentProject?.config;

  // An errored project (folder gone / roubo.yaml missing) has no config.
  // The Benches tab can't render without config, so redirect to Settings,
  // where the user can fix the config or unregister the project.
  useEffect(() => {
    if (currentProject && !hasConfig && !isOnSettings && projectId) {
      navigate(`/projects/${projectId}/settings`, { replace: true });
    }
  }, [currentProject, hasConfig, isOnSettings, projectId, navigate]);

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

  const clearPendingAssignment = useCallback((externalId: string) => {
    setPendingAssignments((prev) => {
      const next = new Map(prev);
      for (const [pos, assignment] of next) {
        if (assignment.externalId === externalId) {
          next.delete(pos);
          break;
        }
      }
      return next;
    });
  }, []);

  // Creates a bench for an issue or alert. Plain issues assign by issueNumber;
  // security alerts (issueNumber === null) assign by their externalId.
  const handleCreateBenchWithIssue = useCallback(
    (
      target: { externalId: string; issueNumber: number | null },
      conflictResolution?: "resume" | "new",
    ) => {
      if (!projectId) return;
      const { externalId, issueNumber } = target;
      createBench.mutate(
        {
          projectId,
          ...(issueNumber !== null ? { issueNumber } : { externalId }),
          branchConflictResolution: conflictResolution,
        },
        {
          onSuccess: (result) => {
            removePending(externalId);
            clearPendingAssignment(externalId);
            const response = result as CreateBenchWithIssueResponse;
            if (response.status === "conflict") {
              setBranchConflict({ ...response.branchConflict, externalId, issueNumber });
            }
          },
          onError: (err) => {
            removePending(externalId);
            clearPendingAssignment(externalId);
            addToast(err instanceof Error && err.message ? err.message : "Failed to create bench", {
              duration: 8000,
            });
          },
        },
      );
    },
    [projectId, createBench, removePending, clearPendingAssignment, addToast],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const issue = event.active.data.current?.issue as NormalizedIssue | undefined;
    setDraggingIssue(issue ?? null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingIssue(null);
      const { active, over } = event;
      if (!over || !projectId) return;

      const issue = active.data.current?.issue as NormalizedIssue | undefined;
      const position = over.data.current?.position as number | undefined;
      if (!issue || position === undefined) return;

      const externalId = issue.externalId;
      // Plain GitHub issues assign by number; everything else (alerts, Jira
      // keys, any active integration) assigns by externalId. The server fetches
      // the issue via the active plugin and routes alert vs plugin-issue.
      const issueNumber = issueNumberFromExternalId(externalId);

      addPending(externalId);
      setPendingAssignments((prev) => {
        const next = new Map(prev);
        next.set(position, {
          externalId,
          issueTitle: issue.title,
        });
        return next;
      });

      let cancelled = false;
      addToast(`Setting up bench for ${externalId} - ${issue.title}`, {
        duration: 3000,
        action: {
          label: "Cancel",
          onPress: () => {
            cancelled = true;
            removePending(externalId);
            setPendingAssignments((prev) => {
              const next = new Map(prev);
              next.delete(position);
              return next;
            });
          },
        },
        onExpire: () => {
          if (!cancelled) {
            handleCreateBenchWithIssue({ externalId, issueNumber });
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

  const handleCreateTestBench = useCallback(() => {
    setShowSpecPicker(true);
  }, []);

  // Create a TestBench bound to the focused spec (#418). On success the bench is
  // marked to open on its "testbench" tab, then we navigate into the bench detail.
  const handleSpecPickerCreate = useCallback(
    (focusedSpecPath: string) => {
      if (!projectId) return;
      createBench.mutate(
        { projectId, variant: "testbench", focusedSpecPath },
        {
          onSuccess: (result) => {
            setShowSpecPicker(false);
            const bench = result as Bench;
            setBenchActiveTab(projectId, bench.id, "testbench");
            navigate(`/projects/${projectId}/benches/${bench.id}`);
          },
          onError: (err) => {
            addToast(
              err instanceof Error && err.message ? err.message : "Failed to create TestBench",
              { duration: 8000 },
            );
          },
        },
      );
    },
    [projectId, createBench, navigate, addToast],
  );

  const outletContext = useMemo(
    () =>
      ({
        benchPositions,
        pendingAssignments,
        isLoading,
        openCreateBench,
        pickIssueForBench: handleEmptyBenchPickIssue,
        testBenchEnabled,
        onCreateTestBench: handleCreateTestBench,
        hasGitHub,
        benches: benches ?? [],
        projectConfig: currentProject?.config as RouboConfig,
        pendingIssueExternalIds,
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
      testBenchEnabled,
      handleCreateTestBench,
      hasGitHub,
      benches,
      currentProject?.config,
      pendingIssueExternalIds,
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
    (externalId: string, issueTitle: string) => {
      setShowIssuePicker(false);
      if (!projectId) return;
      // GitHub issues route by number; everything else (Jira, alerts) by
      // externalId. handleCreateBenchWithIssue picks the path from issueNumber.
      const issueNumber = issueNumberFromExternalId(externalId);
      addPending(externalId);
      const position = issuePickerPosition;
      if (position !== null) {
        setPendingAssignments((prev) => {
          const next = new Map(prev);
          next.set(position, { externalId, issueTitle });
          return next;
        });
      }
      let cancelled = false;
      addToast(`Setting up bench for ${externalId} - ${issueTitle}`, {
        duration: 3000,
        action: {
          label: "Cancel",
          onPress: () => {
            cancelled = true;
            removePending(externalId);
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
            handleCreateBenchWithIssue({ externalId, issueNumber });
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

  // All-projects view (/ route) and fallback when project data is loading.
  // Registered-but-errored projects (no config) still render the single-project
  // layout below so the user can reach Settings and unregister.
  if (!projectId || !currentProject) {
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
  const projectName = currentProject?.config?.project?.displayName ?? currentProject?.id;
  return (
    <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-full">
        <nav
          aria-label="Breadcrumb"
          className="px-8 pt-5 text-[12px] text-stone-500 dark:text-stone-500"
        >
          <Link to="/" className="hover:text-stone-900 dark:hover:text-stone-200 transition-colors">
            All Projects
          </Link>
          <span aria-hidden="true" className="mx-2 text-stone-400 dark:text-stone-600">
            /
          </span>
          <span aria-current="page" className="text-stone-700 dark:text-stone-300">
            {projectName}
          </span>
        </nav>
        <div className="border-b border-stone-200 dark:border-stone-800/60 px-8 pt-3">
          <nav aria-label="Project tabs" className="flex items-center gap-1">
            {hasConfig && hasGitHub && issueQueueCollapsed && !isOnSettings && (
              <Button
                onPress={onToggleIssueQueue}
                className="p-1.5 rounded-md text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700/50 transition-colors outline-none mr-1"
                aria-label="Show cut list"
              >
                <PanelLeft size={16} />
              </Button>
            )}
            {hasConfig && (
              <NavLink to="." end className={tabClassName}>
                Benches
              </NavLink>
            )}
            <NavLink to="settings" className={tabClassName}>
              Settings
            </NavLink>
          </nav>
        </div>

        <div key={location.pathname} className="flex-1 min-h-0 overflow-hidden animate-tab-fade-in">
          {hasConfig || isOnSettings ? <Outlet context={outletContext} /> : null}
        </div>
      </div>

      <DragOverlay>
        {draggingIssue && (
          <div className="bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-700/50 rounded-lg px-3 py-2 shadow-xl max-w-[280px] opacity-90">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-stone-400 dark:text-stone-500">
                {draggingIssue.externalId}
              </span>
              <span className="text-xs font-medium text-stone-800 dark:text-stone-200 truncate">
                {draggingIssue.title}
              </span>
            </div>
          </div>
        )}
      </DragOverlay>

      {currentProject.config && (
        <>
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
            benches={benches ?? []}
            pendingIssueExternalIds={pendingIssueExternalIds}
          />

          {projectId && (
            <SpecPickerModal
              isOpen={showSpecPicker}
              onClose={() => setShowSpecPicker(false)}
              projectId={projectId}
              onCreate={handleSpecPickerCreate}
              isCreating={createBench.isPending}
            />
          )}

          {branchConflict && (
            <BranchConflictDialog
              isOpen
              onClose={() => setBranchConflict(null)}
              conflict={branchConflict}
              onResume={() => {
                handleCreateBenchWithIssue(
                  {
                    externalId: branchConflict.externalId,
                    issueNumber: branchConflict.issueNumber,
                  },
                  "resume",
                );
                setBranchConflict(null);
              }}
              onCreateNew={() => {
                handleCreateBenchWithIssue(
                  {
                    externalId: branchConflict.externalId,
                    issueNumber: branchConflict.issueNumber,
                  },
                  "new",
                );
                setBranchConflict(null);
              }}
            />
          )}

          {projectId &&
            integration?.plugin &&
            !integration.plugin.installed &&
            !missingPluginSkipped.has(projectId) && (
              <MissingPluginDialog
                projectId={projectId}
                pluginId={integration.plugin.id}
                pluginSource={integration.effective.pluginSource}
                onClose={() => setMissingPluginSkipped((prev) => new Set(prev).add(projectId))}
                onSkip={() => setMissingPluginSkipped((prev) => new Set(prev).add(projectId))}
              />
            )}

          {/* Mutually exclusive with MissingPluginDialog above: that branch only
              fires when plugin.installed === false; this one requires installed
              === true && status === "disabled". */}
          {projectId &&
            integration?.plugin &&
            integration.plugin.installed &&
            integration.plugin.status === "disabled" &&
            !enablePluginSkipped.has(projectId) && (
              <EnablePluginPromptModal
                projectId={projectId}
                pluginId={integration.plugin.id}
                pluginName={integration.plugin.manifest?.name ?? integration.plugin.id}
                onCancel={() => setEnablePluginSkipped((prev) => new Set(prev).add(projectId))}
                onEnabled={() => {
                  // Modal unmounts automatically once the project-integration
                  // query (invalidated by the modal) returns status: "enabled".
                }}
              />
            )}
        </>
      )}
    </DndContext>
  );
}
