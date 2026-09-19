import { GitBranch } from "lucide-react";
import { useProjectSettings } from "../../hooks/useProjectSettings";
import Tile from "./Tile";

interface Props {
  projectId: string;
}

type BranchStatus = "loading" | "error" | "present" | "missing";

export default function DefaultBranchTile({ projectId }: Props) {
  const { settings, isLoading } = useProjectSettings(projectId);

  const branch = settings?.defaultBranch;
  const branchError = settings?.defaultBranchError;

  let status: BranchStatus;
  if (isLoading) status = "loading";
  else if (branchError) status = "error";
  else if (branch) status = "present";
  else status = "missing";

  const secondary =
    status === "present" ? (
      <>
        Detected from <code className="text-11">origin/HEAD</code>
      </>
    ) : undefined;

  return (
    <Tile
      icon={<GitBranch aria-hidden="true" size={14} />}
      title="Default branch"
      secondary={secondary}
    >
      {status === "loading" && (
        <div>
          <div className="h-5 bg-stone-200 dark:bg-stone-700 rounded w-24" />
          <span className="sr-only">Detecting default branch…</span>
        </div>
      )}
      {status === "error" && (
        <div role="alert">
          <p className="text-12 font-medium text-red-600 dark:text-red-400">Unable to detect</p>
          {branchError && (
            <p className="text-11 text-red-500 dark:text-red-400 mt-1">{branchError}</p>
          )}
        </div>
      )}
      {status === "present" && (
        <code className="font-mono text-16 text-stone-800 dark:text-stone-200">{branch}</code>
      )}
      {status === "missing" && (
        <span
          aria-label="No default branch detected"
          className="text-stone-500 dark:text-stone-400"
        >
          ·
        </span>
      )}
    </Tile>
  );
}
