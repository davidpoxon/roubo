import { useCallback, useRef, useEffect } from "react";
import { TextField, Label, Input, Button } from "react-aria-components";
import { GitBranch } from "lucide-react";
import type { ProjectConfig, LayoutConfig, RepoScanResult } from "@roubo/shared";
import type { WizardAction } from "./wizardReducer";
import { INPUT } from "./styles";
import Spinner from "../Spinner";
import { useProjectSettings } from "../../hooks/useProjectSettings";

interface Props {
  project: Partial<ProjectConfig>;
  layout?: Partial<LayoutConfig>;
  scanResult?: RepoScanResult;
  projectId?: string;
  validationErrors?: Record<string, string>;
  dispatch: React.Dispatch<WizardAction>;
}

const NAME_PATTERN = /^[a-z0-9-]+$/;
const STRUCTURE_TYPES = ["meta-repo", "monorepo", "single-repo"] as const;

// FR-070 (WU-057): Repository, Linked GitHub Project, and Submodules moved out
// of this Identity step into the plugin Configure modal. This section now only
// edits Roubo-shaped fields (name, displayName, layout) plus the detected
// default branch; GitHub-shaped config is owned by the active plugin's tab.
export default function SectionProjectInfo({
  project,
  layout,
  scanResult,
  projectId,
  validationErrors = {},
  dispatch,
}: Props) {
  const displayNameTouched = useRef(false);

  useEffect(() => {
    if (project.displayName && project.name && project.displayName !== project.name) {
      displayNameTouched.current = true;
    }
  }, [project.displayName, project.name]);

  const update = useCallback(
    (changes: Partial<ProjectConfig>) => {
      dispatch({ type: "UPDATE_PROJECT", payload: changes });
    },
    [dispatch],
  );

  const updateLayout = useCallback(
    (changes: Partial<LayoutConfig>) => {
      dispatch({ type: "UPDATE_STRUCTURE", payload: changes });
    },
    [dispatch],
  );

  const nameError =
    project.name && !NAME_PATTERN.test(project.name)
      ? "Lowercase letters, numbers, and hyphens only"
      : validationErrors["project.name"];
  const displayNameError = validationErrors["project.displayName"];
  const layoutTypeError = validationErrors["layout.type"];

  return (
    <div className="space-y-5">
      <TextField
        value={project.name ?? ""}
        onChange={(v) => {
          update(displayNameTouched.current ? { name: v } : { name: v, displayName: v });
        }}
      >
        <Label className="block text-12 text-text-secondary mb-1.5">Name</Label>
        <Input placeholder="my-project" className={INPUT} />
        {nameError && <p className="mt-1 text-11 text-red-400">{nameError}</p>}
      </TextField>

      <TextField
        value={project.displayName ?? ""}
        onChange={(v) => {
          displayNameTouched.current = true;
          update({ displayName: v });
        }}
      >
        <Label className="block text-12 text-text-secondary mb-1.5">Display name</Label>
        <Input placeholder="My Project" className={INPUT} />
        {displayNameError && <p className="mt-1 text-11 text-red-400">{displayNameError}</p>}
      </TextField>

      <div>
        <Label className="block text-12 text-text-secondary mb-1.5">Repository structure</Label>
        <div role="group" aria-label="Repository structure" className="flex gap-1">
          {STRUCTURE_TYPES.map((t) => (
            <Button
              key={t}
              onPress={() => updateLayout({ type: t })}
              className={`px-3 py-1.5 text-12 rounded-control transition-colors outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-focus-ring ${
                layout?.type === t
                  ? "bg-stone-700 text-stone-100"
                  : "text-text-secondary hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-200/50 dark:hover:bg-stone-800/60"
              }`}
            >
              {t}
            </Button>
          ))}
        </div>
        {layoutTypeError ? (
          <p className="mt-1 text-11 text-red-400">{layoutTypeError}</p>
        ) : (
          scanResult &&
          layout?.type &&
          layout.type === scanResult.detected.structureType && (
            <p className="mt-1 text-11 text-stone-500 dark:text-stone-400">Auto-detected</p>
          )
        )}
      </div>

      {projectId && <DefaultBranchField projectId={projectId} />}
    </div>
  );
}

function DefaultBranchField({ projectId }: { projectId: string }) {
  const { settings, isLoading } = useProjectSettings(projectId);
  const branch = settings?.defaultBranch;
  const branchError = settings?.defaultBranchError;

  return (
    <div>
      <Label className="text-12 text-text-secondary mb-1.5 flex items-center gap-1.5">
        <GitBranch size={12} className="text-stone-500 dark:text-stone-400" />
        Default branch
      </Label>
      {isLoading ? (
        <div className="flex items-center gap-2 text-12 text-stone-500 dark:text-stone-400">
          <Spinner />
          Detecting…
        </div>
      ) : branchError ? (
        <p className="text-12 text-red-400">{branchError}</p>
      ) : branch ? (
        <div>
          <code className="font-mono text-13 text-stone-800 dark:text-stone-200">{branch}</code>
          <p className="text-11 text-stone-500 dark:text-stone-400 mt-0.5">
            Detected from <code className="text-11">origin/HEAD</code>
          </p>
        </div>
      ) : (
        <span className="text-stone-500 dark:text-stone-400 text-13">·</span>
      )}
    </div>
  );
}
