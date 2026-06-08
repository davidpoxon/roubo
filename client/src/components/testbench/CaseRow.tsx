import type { CaseRowModel } from "./rollup";
import StatusIndicator from "./StatusIndicator";

// One case row in the virtualised list (#419). Renders only the human-readable
// case fields (id + title) plus the StatusIndicator: the raw JSON plan/result is
// never serialised into the DOM (acceptance criterion). The case detail + marks
// surface is a separate slice (#16) and out of scope here.
export default function CaseRow({ model }: { model: CaseRowModel }) {
  const { case: c, status } = model;
  return (
    <div className="flex items-center gap-3 px-4 py-2 min-w-0">
      <span className="font-mono text-[11px] text-stone-400 dark:text-stone-600 shrink-0">
        {c.id}
      </span>
      <span className="text-sm text-stone-800 dark:text-stone-200 truncate min-w-0 flex-1">
        {c.title}
      </span>
      <StatusIndicator status={status} />
    </div>
  );
}
