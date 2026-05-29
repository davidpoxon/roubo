import Spinner from "./Spinner";
import { shortIdFromExternalId } from "../lib/issue-id";

export default function PendingBenchCard({
  position,
  externalId,
  issueTitle,
}: {
  position: number;
  externalId: string;
  issueTitle: string;
}) {
  return (
    <div className="h-[260px]">
      <div className="border-l-[3px] border-l-amber-500 bg-stone-100 dark:bg-stone-900/50 rounded-xl h-full ring-1 ring-inset ring-stone-200/80 dark:ring-stone-800/30">
        <div className="p-4 flex flex-col h-full">
          {/* Header */}
          <div className="shrink-0">
            <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
              Bench {position}
            </p>
          </div>

          {/* Issue */}
          <div className="flex items-center gap-1.5 text-xs text-stone-500 mt-2.5 shrink-0">
            <span className="font-mono text-violet-400 shrink-0">
              #{shortIdFromExternalId(externalId)}
            </span>
            <span className="truncate">{issueTitle}</span>
          </div>

          {/* Setting up indicator */}
          <div className="flex-1 flex items-start gap-2 mt-2.5">
            <Spinner />
            <span className="text-xs text-amber-600 dark:text-amber-400">Setting up...</span>
          </div>
        </div>
      </div>
    </div>
  );
}
