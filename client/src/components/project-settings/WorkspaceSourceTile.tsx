import { GitBranchPlus } from "lucide-react";
import type { ProjectSettings } from "@roubo/shared";
import { useProjectSettings } from "../../hooks/useProjectSettings";
import Spinner from "../Spinner";
import { SettingToggle } from "./SettingToggle";
import Tile from "../settings/Tile";

export function WorkspaceSourceTile({
  projectId,
  draft,
  onChange,
  original,
}: {
  projectId: string;
  draft: ProjectSettings["worktreeSource"];
  onChange: (v: ProjectSettings["worktreeSource"]) => void;
  original: ProjectSettings["worktreeSource"];
}) {
  const { settings, isLoading, isFetchError } = useProjectSettings(projectId);

  const isDirty =
    draft.branchFromDefault !== original.branchFromDefault ||
    draft.pullLatest !== original.pullLatest;

  const updateDraft = (patch: Partial<ProjectSettings["worktreeSource"]>) => {
    onChange({ ...draft, ...patch });
  };

  return (
    <Tile
      data-testid="workspace-source-tile"
      icon={<GitBranchPlus size={13} aria-hidden />}
      title="Workspace source"
      secondary="How benches start from the working tree"
      isDirty={isDirty}
    >
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-stone-400 dark:text-stone-600 py-2">
          <Spinner />
          Loading...
        </div>
      ) : isFetchError ? (
        <p className="text-sm text-red-500 dark:text-red-400">
          Failed to load workspace source settings. Please try again.
        </p>
      ) : (
        <div className="space-y-6">
          <div>
            <SettingToggle
              isSelected={draft.branchFromDefault}
              onChange={(val) => updateDraft({ branchFromDefault: val })}
              label="Branch new benches from the default branch"
              description="When creating a new bench, start from the repo's default branch (e.g. main) instead of the currently checked-out branch."
            />
            {draft.branchFromDefault && (
              <p className="mt-2 text-[11px] text-stone-400 dark:text-stone-600 font-mono leading-relaxed">
                git worktree add &lt;workspacePath&gt; -b &lt;benchBranch&gt;{" "}
                {settings?.defaultBranch ? settings.defaultBranch : <>&lt;defaultBranch&gt;</>}
              </p>
            )}
            {draft.branchFromDefault &&
              (settings?.defaultBranch || settings?.defaultBranchError) && (
                <div className="mt-2 text-xs">
                  {settings?.defaultBranch ? (
                    <p className="text-stone-500 dark:text-stone-400">
                      Default branch:{" "}
                      <span className="font-mono text-stone-700 dark:text-stone-300">
                        {settings.defaultBranch}
                      </span>
                    </p>
                  ) : settings?.defaultBranchError ? (
                    <p className="text-red-500 dark:text-red-400">{settings.defaultBranchError}</p>
                  ) : null}
                </div>
              )}
          </div>
          <div>
            <SettingToggle
              isSelected={draft.pullLatest}
              onChange={(val) => updateDraft({ pullLatest: val })}
              label="Pull latest before workspace setup"
              description="Fetch and fast-forward the source branch before creating the new workspace so the bench starts from the latest commit."
            />
            {draft.pullLatest && (
              <p className="mt-2 text-[11px] text-stone-400 dark:text-stone-600 font-mono leading-relaxed">
                {`git fetch origin ${draft.branchFromDefault ? (settings?.defaultBranch ?? "<defaultBranch>") : "<currentBranch>"} && git merge --ff-only origin/${draft.branchFromDefault ? (settings?.defaultBranch ?? "<defaultBranch>") : "<currentBranch>"}`}
              </p>
            )}
          </div>
        </div>
      )}
    </Tile>
  );
}
