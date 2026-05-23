import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { useParams, Routes, Route, useBlocker, useNavigate, Link } from "react-router-dom";
import { Plus, Zap } from "lucide-react";
import type { JigMeta, JigReference } from "@roubo/shared";
import { useProjects } from "../hooks/useProjects";
import { useToast } from "../hooks/useToast";
import { useJigs, useDeleteProjectJig, useDuplicateProjectJig } from "../hooks/useJigs";
import { ApiError, isJigReferencedError } from "../lib/api";
import Spinner from "./Spinner";
import { ProjectDefaultJigTile } from "./ProjectDefaultJigTile";
import SetupTile from "./settings/SetupTile";
import DefaultBranchTile from "./settings/DefaultBranchTile";
import PortAssignmentTile from "./settings/PortAssignmentTile";
import Tile from "./settings/Tile";
import { OverrideBadge } from "./settings/OverrideBadge";
import { WorkspaceSourceTile } from "./project-settings/WorkspaceSourceTile";
import { AutoClearOverrideTile } from "./project-settings/AutoClearOverrideTile";
import { EnforceIssueDependenciesOverrideTile } from "./project-settings/EnforceIssueDependenciesOverrideTile";
import { WorkUnitAutoClearOverrideTile } from "./project-settings/WorkUnitAutoClearOverrideTile";
import { SettingsSaveBar } from "./project-settings/SettingsSaveBar";
import { IssueTypeMappingsSection } from "./project-settings/IssueTypeMappingsSection";
import { useSettingsOverviewDraft } from "./project-settings/useSettingsOverviewDraft";
import UnsavedChangesDialog from "./jig-editor/UnsavedChangesDialog";
import JigRow from "./jig-editor/JigRow";
import DeleteJigDialog from "./jig-editor/DeleteJigDialog";
import Setup from "./setup/Setup";
import type { RegisteredProject } from "@roubo/shared";
import DangerZoneTile from "./settings/DangerZoneTile";
import { ProjectPermissionsInlineSection } from "./project-settings/ProjectPermissionsInlineSection";
import { ProjectPermissionsEditorPage } from "./project-settings/ProjectPermissionsEditorPage";
import IssueSourceTile from "./IssueSourceTile";

function ProjectCustomJigsList({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const { data: jigs, isLoading } = useJigs(projectId);
  const remove = useDeleteProjectJig(projectId);
  const duplicate = useDuplicateProjectJig(projectId);

  const [deletingJig, setDeletingJig] = useState<JigMeta | null>(null);
  const [deleteReferences, setDeleteReferences] = useState<JigReference[] | undefined>();

  const projectJigs = (jigs ?? []).filter((bp) => bp.source === "project");

  const handleDeleteConfirm = async () => {
    if (!deletingJig) return;
    try {
      await remove.mutateAsync(deletingJig.id);
      setDeletingJig(null);
      setDeleteReferences(undefined);
      addToast("Jig deleted.");
    } catch (err) {
      if (isJigReferencedError(err)) {
        setDeleteReferences(err.details.references);
      } else if (err instanceof ApiError) {
        addToast(err.message);
        setDeletingJig(null);
      } else {
        addToast("Failed to delete jig.");
        setDeletingJig(null);
      }
    }
  };

  const handleDuplicate = (bp: JigMeta) => {
    void duplicate
      .mutateAsync({ id: bp.id })
      .then((created) => navigate(`/projects/${projectId}/jigs/edit/${created.id}`))
      .catch((err: unknown) => {
        if (err instanceof ApiError) addToast(err.message);
        else addToast("Failed to duplicate jig.");
      });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600">
          Custom jigs
        </h3>
        <Link
          to={`/projects/${projectId}/jigs/new`}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-stone-950 bg-amber-500 hover:bg-amber-400 rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-950"
        >
          <Plus size={12} />
          New jig
        </Link>
      </div>

      {isLoading ? (
        <p className="text-xs text-stone-400 dark:text-stone-600">Loading…</p>
      ) : projectJigs.length === 0 ? (
        <p className="text-xs text-stone-400 dark:text-stone-600 leading-relaxed">
          No project jigs yet. Create one to override or supplement app-level jigs for this project.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {projectJigs.map((jig) => (
            <JigRow
              key={jig.id}
              jig={jig}
              editHref={`/projects/${projectId}/jigs/edit/${jig.id}`}
              onDelete={(bp) => {
                setDeleteReferences(undefined);
                setDeletingJig(bp);
              }}
              onDuplicate={handleDuplicate}
              isDuplicating={duplicate.isPending}
            />
          ))}
        </div>
      )}

      <p className="mt-4 text-[11px] text-stone-400 dark:text-stone-600 leading-relaxed">
        Project jigs live in{" "}
        <span className="font-mono text-stone-500 dark:text-stone-500">
          &lt;repo&gt;/.roubo/jigs/*.md
        </span>
        .
      </p>

      {deletingJig && (
        <DeleteJigDialog
          isOpen={!!deletingJig}
          jig={deletingJig}
          onCancel={() => {
            setDeletingJig(null);
            setDeleteReferences(undefined);
          }}
          onConfirm={handleDeleteConfirm}
          references={deleteReferences}
          isPending={remove.isPending}
        />
      )}
    </div>
  );
}

function SettingsOverview({ project }: { project: RegisteredProject }) {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const {
    draftWorktreeSource,
    setDraftWorktreeSource,
    draftJig,
    setDraftJig,
    draftAutoClear,
    setDraftAutoClear,
    draftEnforceIssueDependencies,
    setDraftEnforceIssueDependencies,
    draftWorkUnitAutoClear,
    setDraftWorkUnitAutoClear,
    draftIssueTypeMappings,
    setDraftIssueTypeMappings,
    originalWorktreeSource,
    hasAnyDirty,
    isJigDirty,
    isIssueTypeMappingsDirty,
    isSaving,
    saveErrors,
    save,
    discard,
    justSavedRef,
  } = useSettingsOverviewDraft(project.id, project);

  const isJigOverridden = draftJig != null;
  const hasIssueTypeOverrides = Object.keys(draftIssueTypeMappings ?? {}).length > 0;
  const jigsTileOverridden = isJigOverridden || hasIssueTypeOverrides;
  const jigsTileDirty = Boolean(isJigDirty || isIssueTypeMappingsDirty);

  const isMetaRepo = project.config?.layout?.type === "meta-repo";

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      hasAnyDirty && !justSavedRef.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!hasAnyDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasAnyDirty]);

  const handleSave = async () => {
    const result = await save();
    if (result.ok) {
      addToast("Settings saved.");
    }
  };

  return (
    <>
      <div data-testid="project-settings-content" className="w-full p-8 space-y-8">
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
              Issue source
            </h2>
          </div>
          <IssueSourceTile projectId={project.id} />
        </section>
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-stone-600 shrink-0" />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
              Setup
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <SetupTile projectId={project.id} />
            <DefaultBranchTile projectId={project.id} />
          </div>
        </section>
        <section>
          <div className="flex items-center justify-between gap-2 mb-4">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-stone-600 shrink-0" />
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
                Bench behaviour
              </h2>
            </div>
            <p className="text-[11px] text-stone-400 dark:text-stone-600">
              Project overrides are marked{" "}
              <span className="text-amber-500 font-medium">override</span>
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <WorkspaceSourceTile
              projectId={project.id}
              draft={draftWorktreeSource}
              onChange={setDraftWorktreeSource}
              original={originalWorktreeSource}
            />
            <AutoClearOverrideTile draft={draftAutoClear} onChange={setDraftAutoClear} />
            <PortAssignmentTile projectId={project.id} />
            <EnforceIssueDependenciesOverrideTile
              draft={draftEnforceIssueDependencies}
              onChange={setDraftEnforceIssueDependencies}
            />
            {isMetaRepo && (
              <WorkUnitAutoClearOverrideTile
                draft={draftWorkUnitAutoClear}
                onChange={setDraftWorkUnitAutoClear}
              />
            )}
          </div>
        </section>
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-stone-600 shrink-0" />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
              Jigs
            </h2>
          </div>
          <Tile
            icon={<Zap size={13} aria-hidden />}
            title="Jig"
            isOverridden={jigsTileOverridden}
            isDirty={jigsTileDirty}
            headerAction={jigsTileOverridden ? <OverrideBadge /> : undefined}
          >
            <ProjectDefaultJigTile
              project={project}
              showProjectName={false}
              embedded
              draft={draftJig}
              onChange={setDraftJig}
            />
            <div className="mt-8">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-stone-400 dark:text-stone-600 mb-3">
                Issue type mappings
              </h3>
              <IssueTypeMappingsSection
                projectId={project.id}
                draft={draftIssueTypeMappings}
                onChange={setDraftIssueTypeMappings}
                embedded
              />
            </div>
            <p className="text-[11px] text-stone-400 dark:text-stone-600 mt-6 leading-relaxed">
              Changes write to{" "}
              <span className="font-mono text-stone-500 dark:text-stone-500">
                {"<repo>/.roubo/roubo.yaml"}
              </span>{" "}
              — commit alongside your other work.
            </p>
          </Tile>
          <div className="mt-6">
            <ProjectCustomJigsList projectId={project.id} />
          </div>
        </section>
        <section>
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-stone-600 shrink-0" />
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
                Claude Code permissions
              </h2>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-stone-400 dark:text-stone-600">
                Merged into <span className="font-mono">.claude/settings.local.json</span> on bench
                setup
              </span>
              <Button
                onPress={() => navigate(`/projects/${project.id}/settings/permissions`)}
                className="text-[11px] px-2.5 py-1 rounded-md border border-stone-200 dark:border-stone-700 text-stone-600 dark:text-stone-300 hover:border-stone-400 dark:hover:border-stone-600 hover:text-stone-900 dark:hover:text-stone-100 outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-amber-400 transition-colors duration-150 shrink-0"
              >
                Edit permissions →
              </Button>
            </div>
          </div>
          <ProjectPermissionsInlineSection projectId={project.id} />
        </section>
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-red-400 dark:bg-red-600 shrink-0" />
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-stone-500">
              Danger zone
            </h2>
          </div>
          <DangerZoneTile projectId={project.id} />
        </section>
      </div>

      <SettingsSaveBar
        hasAnyDirty={hasAnyDirty}
        isSaving={isSaving}
        saveErrors={saveErrors}
        onSave={handleSave}
        onDiscard={discard}
      />

      <UnsavedChangesDialog
        isOpen={blocker.state === "blocked"}
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
    </>
  );
}

export default function ProjectSettingsTab() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: projects, isLoading } = useProjects();
  const project = projects?.find((p) => p.id === projectId);

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto overscroll-contain flex items-center gap-2 p-8 text-xs text-stone-400 dark:text-stone-600">
        <Spinner />
        Loading…
      </div>
    );
  }

  if (!project) {
    return (
      <div className="h-full overflow-y-auto overscroll-contain p-8 text-xs text-stone-400 dark:text-stone-600">
        Project not found.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <Routes>
        <Route index element={<SettingsOverview project={project} />} />
        <Route path="setup" element={<Setup />} />
        <Route
          path="permissions"
          element={<ProjectPermissionsEditorPage projectId={projectId as string} />}
        />
      </Routes>
    </div>
  );
}
