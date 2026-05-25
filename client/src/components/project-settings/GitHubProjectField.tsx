import { Label } from "react-aria-components";
import Select from "../Select";
import Spinner from "../Spinner";
import GitHubErrorState from "../GitHubErrorState";
import { useGitHubProjects } from "../../hooks/useSetup";

interface Props {
  repo: string | undefined;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}

export default function GitHubProjectField({ repo, value, onChange }: Props) {
  const { data: projects, isLoading, error, refetch } = useGitHubProjects(repo ?? "");

  const projectItems = (projects ?? []).map((p) => ({
    value: String(p.number),
    label: `#${p.number} ${p.title}`,
  }));

  return (
    <div>
      <Label className="block text-xs text-stone-500 mb-1.5">GitHub project</Label>
      {!repo || !repo.includes("/") ? (
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
          value={value !== undefined ? String(value) : ""}
          onChange={(v) => onChange(v ? parseInt(v, 10) : undefined)}
          placeholder="Optional"
          allowClear
        />
      )}
    </div>
  );
}
