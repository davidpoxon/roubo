import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { useParams, Routes, Route, useBlocker, useNavigate, Link } from "react-router";
import { Plus, Zap } from "lucide-react";
import type { JigMeta, JigReference } from "@roubo/shared";
import { useProjects } from "../hooks/useProjects";
import { useProjectIntegration } from "../hooks/useProjectIntegration";
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
import { EnforceIssueDependenciesOverrideTile } from "./project-settings/EnforceIssueDependenciesOverrideTile";
import { SettingsSaveBar } from "./project-settings/SettingsSaveBar";
import { IssueTypeMappingsSection } from "./project-settings/IssueTypeMappingsSection";
import { AgentOverridesSection } from "./project-settings/AgentOverridesSection";
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
        <h3 className="text-11 font-semibold uppercase tracking-label text-text-secondary">
          Custom jigs
        </h3>
        <Link
          to={`/projects/${projectId}/jigs/new`}
          className="flex items-center gap-1.5 px-3 py-1.5 text-12 font-medium text-on-accent bg-accent not-disabled:hover:bg-accent-hover rounded-control transition-colors outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base not-disabled:active:bg-accent-active"
        >
          <Plus size={12} />
          New jig
        </Link>
      </div>

      {isLoading ? (
        <p className="text-12 text-text-secondary">Loading…</p>
      ) : projectJigs.length === 0 ? (
        <p className="text-12 text-text-secondary leading-relaxed">
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

      <p className="mt-4 text-11 text-text-secondary leading-relaxed">
        Project jigs live in{" "}
        <span className="font-mono text-text-secondary">&lt;repo&gt;/.roubo/jigs/*.md</span>.
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
    draftEnforceIssueDependencies,
    setDraftEnforceIssueDependencies,
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

  // IP-FR-069: section title reflects the active plugin's display name; falls
  // back to "Source" when none is configured.
  const { data: integration } = useProjectIntegration(project.id);
  const sourceSectionTitle = integration?.plugin?.manifest?.name ?? "Source";

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
    <div className="flex flex-col h-full min-h-0">
      <div
        data-testid="project-settings-content"
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain w-full p-8 space-y-8"
      >
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
            <h2
              data-testid="project-settings-source-section-title"
              className="text-11 font-semibold uppercase tracking-label text-text-secondary"
            >
              {sourceSectionTitle}
            </h2>
          </div>
          <IssueSourceTile projectId={project.id} title={sourceSectionTitle} />
        </section>
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-border-strong shrink-0" />
            <h2 className="text-11 font-semibold uppercase tracking-label text-text-secondary">
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
              <div className="w-1.5 h-1.5 rounded-full bg-border-strong shrink-0" />
              <h2 className="text-11 font-semibold uppercase tracking-label text-text-secondary">
                Bench behaviour
              </h2>
            </div>
            <p className="text-11 text-text-secondary">
              Project overrides are marked{" "}
              <span className="text-accent-text font-medium">override</span>
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <WorkspaceSourceTile
              projectId={project.id}
              draft={draftWorktreeSource}
              onChange={setDraftWorktreeSource}
              original={originalWorktreeSource}
            />
            <PortAssignmentTile projectId={project.id} />
            <EnforceIssueDependenciesOverrideTile
              draft={draftEnforceIssueDependencies}
              onChange={setDraftEnforceIssueDependencies}
            />
          </div>
        </section>
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-border-strong shrink-0" />
            <h2 className="text-11 font-semibold uppercase tracking-label text-text-secondary">
              Jigs
            </h2>
          </div>
          <Tile
            icon={<Zap size={14} aria-hidden />}
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
              <h3 className="text-11 font-semibold uppercase tracking-label text-text-secondary mb-3">
                Issue type mappings
              </h3>
              <IssueTypeMappingsSection
                projectId={project.id}
                draft={draftIssueTypeMappings}
                onChange={setDraftIssueTypeMappings}
                embedded
              />
            </div>
            <p className="text-11 text-text-secondary mt-6 leading-relaxed">
              Changes write to{" "}
              <span className="font-mono text-text-secondary">{"<repo>/.roubo/roubo.yaml"}</span>.
              Commit alongside your other work.
            </p>
          </Tile>
          <div className="mt-6">
            <ProjectCustomJigsList projectId={project.id} />
          </div>
        </section>
        <section>
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-border-strong shrink-0" />
              <h2 className="text-11 font-semibold uppercase tracking-label text-text-secondary">
                Agent permissions
              </h2>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-11 text-text-secondary">
                Mapped onto the agent's own permission mechanism on bench setup
              </span>
              <Button
                onPress={() => navigate(`/projects/${project.id}/settings/permissions`)}
                className="text-11 px-2.5 py-1 rounded-control border border-border-strong bg-bg-surface text-text-secondary hover:bg-bg-hover hover:text-text-primary outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring transition-colors duration-150 shrink-0"
              >
                Edit permissions →
              </Button>
            </div>
          </div>
          <ProjectPermissionsInlineSection projectId={project.id} />
        </section>
        <section>
          <div className="flex items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-border-strong shrink-0" />
              <h2 className="text-11 font-semibold uppercase tracking-label text-text-secondary">
                Agent overrides
              </h2>
            </div>
            <span className="text-11 text-text-secondary">
              App defaults from <span className="font-mono">Settings &gt; AI Agents</span>, overlaid
              per field
            </span>
          </div>
          <AgentOverridesSection projectId={project.id} />
        </section>
        <section>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-1.5 h-1.5 rounded-full bg-danger shrink-0" />
            <h2 className="text-11 font-semibold uppercase tracking-label text-text-secondary">
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
    </div>
  );
}

export default function ProjectSettingsTab() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: projects, isLoading } = useProjects();
  const project = projects?.find((p) => p.id === projectId);

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto overscroll-contain flex items-center gap-2 p-8 text-12 text-text-secondary">
        <Spinner />
        Loading…
      </div>
    );
  }

  if (!project) {
    return (
      <div className="h-full overflow-y-auto overscroll-contain p-8 text-12 text-text-secondary">
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
