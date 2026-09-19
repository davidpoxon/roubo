import Spinner from "./Spinner";
import StatusIndicator from "./ui/StatusIndicator";
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
      <div className="border border-status-preparing bg-bg-surface rounded-card h-full">
        <div className="p-4 flex flex-col h-full">
          {/* Header */}
          <div className="shrink-0 flex items-center gap-2">
            <p className="text-14 font-semibold text-text-primary">Bench {position}</p>
            <StatusIndicator tone="preparing" label="preparing" className="ml-auto" />
          </div>

          {/* Issue */}
          <div className="flex items-center gap-1.5 text-12 text-text-secondary mt-2.5 shrink-0">
            <span className="font-mono text-accent-text shrink-0">
              #{shortIdFromExternalId(externalId)}
            </span>
            <span className="truncate">{issueTitle}</span>
          </div>

          {/* Setting up indicator */}
          <div className="flex-1 flex items-start gap-2 mt-2.5">
            <Spinner />
            <span className="text-12 text-text-secondary">Setting up...</span>
          </div>
        </div>
      </div>
    </div>
  );
}
