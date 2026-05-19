import { useCallback, useRef, useEffect } from "react";
import { TextField, Label, Input, Button, TooltipTrigger, Tooltip } from "react-aria-components";
import { GitBranch, Info, Plus, X } from "lucide-react";
import type { ProjectConfig, LayoutConfig, RepoScanResult } from "@roubo/shared";
import type { WizardAction } from "./wizardReducer";
import { INPUT } from "./styles";
import Select from "../Select";
import Spinner from "../Spinner";
import { useGitHubProjects } from "../../hooks/useSetup";
import { useProjectSettings } from "../../hooks/useProjectSettings";
import GitHubErrorState from "../GitHubErrorState";

interface Props {
  project: Partial<ProjectConfig>;
  layout?: Partial<LayoutConfig>;
  scanResult?: RepoScanResult;
  projectId?: string;
  dispatch: React.Dispatch<WizardAction>;
  layoutInvalid?: boolean;
}

const NAME_PATTERN = /^[a-z0-9-]+$/;
const PROJECT_TYPES = ["web", "native", "api-only"] as const;
const STRUCTURE_TYPES = ["meta-repo", "monorepo", "single-repo"] as const;

export default function SectionProjectInfo({
  project,
  layout,
  scanResult,
  projectId,
  dispatch,
  layoutInvalid,
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
      : undefined;

  const submodules = layout?.submodules ?? {};
  const subEntries = Object.entries(submodules);

  const addSubmodule = () => {
    updateLayout({ submodules: { ...submodules, "": "" } });
  };

  const updateSubmodule = (oldKey: string, newKey: string, value: string) => {
    const updated = { ...submodules };
    if (oldKey !== newKey) Reflect.deleteProperty(updated, oldKey);
    updated[newKey] = value;
    updateLayout({ submodules: updated });
  };

  const removeSubmodule = (key: string) => {
    const updated = { ...submodules };
    Reflect.deleteProperty(updated, key);
    updateLayout({ submodules: updated });
  };

  return (
    <div className="space-y-5">
      <TextField
        value={project.name ?? ""}
        onChange={(v) => {
          update(displayNameTouched.current ? { name: v } : { name: v, displayName: v });
        }}
      >
        <Label className="block text-xs text-stone-500 mb-1.5">Name</Label>
        <Input placeholder="my-project" className={INPUT} />
        {nameError && <p className="mt-1 text-[11px] text-red-400">{nameError}</p>}
      </TextField>

      <TextField
        value={project.displayName ?? ""}
        onChange={(v) => {
          displayNameTouched.current = true;
          update({ displayName: v });
        }}
      >
        <Label className="block text-xs text-stone-500 mb-1.5">Display name</Label>
        <Input placeholder="My Project" className={INPUT} />
      </TextField>

      <div>
        <Label className="block text-xs text-stone-500 mb-1.5">Project type</Label>
        <div role="group" aria-label="Project type" className="flex gap-1">
          {PROJECT_TYPES.map((t) => (
            <Button
              key={t}
              onPress={() => update({ type: t })}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 ${
                project.type === t
                  ? "bg-stone-700 text-stone-100"
                  : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-200/50 dark:hover:bg-stone-800/60"
              }`}
            >
              {t}
            </Button>
          ))}
        </div>
        {scanResult && <ProjectTypeHint scanResult={scanResult} selectedType={project.type} />}
      </div>

      <div>
        <Label className="block text-xs text-stone-500 mb-1.5">Repository structure</Label>
        <div role="group" aria-label="Repository structure" className="flex gap-1">
          {STRUCTURE_TYPES.map((t) => (
            <Button
              key={t}
              onPress={() => updateLayout({ type: t })}
              className={`px-3 py-1.5 text-xs rounded-lg transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 ${
                layout?.type === t
                  ? "bg-stone-700 text-stone-100"
                  : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-200/50 dark:hover:bg-stone-800/60"
              }`}
            >
              {t}
            </Button>
          ))}
        </div>
        {scanResult && layout?.type && layout.type === scanResult.detected.structureType && (
          <p className="mt-1 text-[10px] text-stone-400 dark:text-stone-600">Auto-detected</p>
        )}
      </div>

      {layout?.type === "meta-repo" && (
        <div>
          <Label className="block text-xs text-stone-500 mb-1.5">Submodules</Label>
          {subEntries.length > 0 && (
            <div className="flex items-center gap-2 mb-1">
              <span className="flex-1 flex items-center gap-1 text-[11px] text-stone-500 dark:text-stone-600">
                Alias
                <TooltipTrigger delay={500}>
                  <Button className="text-stone-400 dark:text-stone-600 hover:text-stone-600 dark:hover:text-stone-400 transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded">
                    <Info size={11} />
                  </Button>
                  <Tooltip className="bg-stone-900 dark:bg-stone-800 text-stone-100 dark:text-stone-200 text-xs px-2 py-1 rounded-md shadow-lg max-w-56">
                    A short name used to reference this submodule in components and tools
                  </Tooltip>
                </TooltipTrigger>
              </span>
              <span className="flex-1 text-[11px] text-stone-600">Directory</span>
              <span className="w-[22px] shrink-0" />
            </div>
          )}
          <div className="space-y-2">
            {subEntries.map(([key, value], i) => (
              <div key={i} className="flex items-center gap-2">
                <TextField
                  value={key}
                  onChange={(v) => updateSubmodule(key, v, value)}
                  aria-label="Submodule alias"
                  className="flex-1"
                >
                  <Input placeholder="alias (e.g. backend)" className={INPUT} />
                </TextField>
                <TextField
                  value={value}
                  onChange={(v) => updateSubmodule(key, key, v)}
                  aria-label="Submodule directory"
                  className="flex-1"
                >
                  <Input placeholder="directory name" className={INPUT} />
                </TextField>
                <Button
                  aria-label="Remove submodule"
                  onPress={() => removeSubmodule(key)}
                  className="p-1 text-stone-600 hover:text-red-400 transition-colors shrink-0 outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
                >
                  <X size={14} />
                </Button>
              </div>
            ))}
          </div>
          <Button
            onPress={addSubmodule}
            className="flex items-center gap-1 mt-2 text-[11px] text-stone-500 hover:text-stone-300 transition-colors outline-none data-[focus-visible]:ring-1 data-[focus-visible]:ring-stone-400 rounded"
          >
            <Plus size={12} />
            Add submodule
          </Button>
          {layoutInvalid && (
            <p className="mt-1.5 text-[11px] text-red-400">
              Add at least one submodule for meta-repo layout
            </p>
          )}
        </div>
      )}

      <TextField value={project.repo ?? ""} onChange={(v) => update({ repo: v })}>
        <Label className="block text-xs text-stone-500 mb-1.5">Repository</Label>
        <Input placeholder="org/repo-name" className={INPUT} />
        {scanResult && <RepoHint scanResult={scanResult} currentRepo={project.repo} />}
      </TextField>

      <GitHubProjectField project={project} update={update} />

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
      <Label className="text-xs text-stone-500 mb-1.5 flex items-center gap-1.5">
        <GitBranch size={11} className="text-stone-400" />
        Default branch
      </Label>
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600">
          <Spinner />
          Detecting…
        </div>
      ) : branchError ? (
        <p className="text-[12px] text-red-400">{branchError}</p>
      ) : branch ? (
        <div>
          <code className="font-mono text-sm text-stone-800 dark:text-stone-200">{branch}</code>
          <p className="text-[10px] text-stone-400 dark:text-stone-600 mt-0.5">
            Detected from <code className="text-[10px]">origin/HEAD</code>
          </p>
        </div>
      ) : (
        <span className="text-stone-400 dark:text-stone-600 text-sm">—</span>
      )}
    </div>
  );
}

function GitHubProjectField({
  project,
  update,
}: {
  project: Partial<ProjectConfig>;
  update: (changes: Partial<ProjectConfig>) => void;
}) {
  const { data: projects, isLoading, error, refetch } = useGitHubProjects(project.repo ?? "");

  const projectItems = (projects ?? []).map((p) => ({
    value: String(p.number),
    label: `#${p.number} ${p.title}`,
  }));

  return (
    <div>
      <Label className="block text-xs text-stone-500 mb-1.5">GitHub project</Label>
      {!project.repo || !project.repo.includes("/") ? (
        <p className="text-xs text-stone-400 dark:text-stone-600">Set a repository first</p>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-xs text-stone-400 dark:text-stone-600">
          <Spinner />
          Loading projects…
        </div>
      ) : error ? (
        <GitHubErrorState error={error} variant="inline" onRetry={() => refetch()} />
      ) : projectItems.length === 0 ? (
        <p className="text-xs text-stone-400 dark:text-stone-600">No projects found</p>
      ) : (
        <Select
          items={projectItems}
          value={String(project.github?.project ?? "")}
          onChange={(v) => update({ github: v ? { project: parseInt(v, 10) } : undefined })}
          placeholder="Optional"
          allowClear
        />
      )}
    </div>
  );
}

function ProjectTypeHint({
  scanResult,
  selectedType,
}: {
  scanResult: RepoScanResult;
  selectedType?: string;
}) {
  const { suggestedProjectType, webFrameworks, nativeFrameworks } = scanResult.detected;
  if (suggestedProjectType && selectedType === suggestedProjectType) {
    const evidence = [...nativeFrameworks, ...webFrameworks];
    const evidenceText = evidence.length > 0 ? ` (found ${evidence.join(", ")})` : "";
    return (
      <p className="mt-1 text-[10px] text-stone-400 dark:text-stone-600">
        Auto-detected{evidenceText}
      </p>
    );
  }
  if (suggestedProjectType === null) {
    return (
      <p className="mt-1 text-[10px] text-stone-400 dark:text-stone-600">
        Could not auto-detect type
      </p>
    );
  }
  return null;
}

function RepoHint({
  scanResult,
  currentRepo,
}: {
  scanResult: RepoScanResult;
  currentRepo?: string;
}) {
  const { suggestedRepo } = scanResult.detected;
  if (suggestedRepo && currentRepo === suggestedRepo) {
    return (
      <p className="mt-1 text-[10px] text-stone-400 dark:text-stone-600">
        Auto-detected from git remote
      </p>
    );
  }
  if (suggestedRepo === null) {
    return (
      <p className="mt-1 text-[10px] text-stone-400 dark:text-stone-600">
        Could not detect from git remote
      </p>
    );
  }
  return null;
}
